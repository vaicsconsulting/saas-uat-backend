import ExcelJS from 'exceljs';
import type { CaseStatus } from '@prisma/client';
import { prisma } from '../db';
import { badRequest } from '../lib/errors';
import { DEFECT_LABEL, STATUS_LABEL, fmtDate, fmtDateTime } from '../lib/format';
import type { AuthUser } from '../types';
import { audit } from './audit';
import { publish } from './bus';
import { assertUnlocked } from './runs';

// VAICS deep blue, same as the Change Management System.
export const NAVY = 'FF0D47A1';

/** Tracker columns in template order. Header text matches the VAICS tracker. */
export const CASE_COLUMNS = [
  { key: 'caseKey', header: 'Test ID', width: 11, aliases: ['id', 'case id', 'test case id'] },
  { key: 'module', header: 'Module', width: 22, aliases: [] },
  { key: 'role', header: 'Role', width: 20, aliases: [] },
  { key: 'path', header: 'Page/Route', width: 26, aliases: ['page', 'route', 'path', 'page route', 'url path'] },
  { key: 'title', header: 'Scenario', width: 36, aliases: ['title', 'test case', 'case title', 'name'] },
  { key: 'preconditions', header: 'Preconditions', width: 30, aliases: ['pre conditions', 'precondition'] },
  { key: 'steps', header: 'Steps', width: 44, aliases: ['test steps', 'steps numbered'] },
  { key: 'testData', header: 'Test Data', width: 20, aliases: [] },
  { key: 'expected', header: 'Expected Result', width: 50, aliases: ['expected', 'expected results'] },
  { key: 'priority', header: 'Priority', width: 9, aliases: [] },
  { key: 'type', header: 'Type', width: 12, aliases: ['test type'] },
  { key: 'status', header: 'Status', width: 11, aliases: ['result'] },
  { key: 'actual', header: 'Actual Result', width: 30, aliases: ['actual', 'actual results'] },
  { key: 'tester', header: 'Tester', width: 14, aliases: ['tested by', 'tested by and date', 'tested by date'] },
  { key: 'date', header: 'Date', width: 12, aliases: ['tested date', 'tested at', 'test date'] },
  { key: 'remarks', header: 'Remarks', width: 24, aliases: ['notes', 'comments'] },
  { key: 'needsConfirmation', header: 'Needs confirmation', width: 40, aliases: [] },
  { key: 'defectId', header: 'Defect/Bug ID', width: 16, aliases: ['defect id', 'bug id', 'defect'] },
  { key: 'failureNotes', header: 'Failure notes', width: 36, aliases: ['failure note'] },
  { key: 'fixedBy', header: 'Fixed by', width: 14, aliases: [] },
  { key: 'fixedAt', header: 'Fixed at', width: 12, aliases: ['fixed date', 'fixed on'] },
  { key: 'fixRef', header: 'Fix reference', width: 24, aliases: ['fix ref', 'commit', 'pr'] },
  { key: 'retestResult', header: 'Retest result', width: 14, aliases: ['retest'] },
  { key: 'retestedBy', header: 'Retested by', width: 14, aliases: [] },
  { key: 'retestedAt', header: 'Retested at', width: 12, aliases: ['retest date', 'retested on'] },
  { key: 'finalStatus', header: 'Final status', width: 14, aliases: ['final result'] },
] as const;
type ColKey = (typeof CASE_COLUMNS)[number]['key'];

const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

/** Maps sheet headers to our fields. Case-insensitive, tolerant of small differences. */
export function mapHeaders(headers: string[]): Partial<Record<ColKey, number>> {
  const out: Partial<Record<ColKey, number>> = {};
  headers.forEach((h, i) => {
    const n = norm(h ?? '');
    if (!n) return;
    for (const c of CASE_COLUMNS) {
      if (out[c.key] !== undefined) continue;
      if (norm(c.header) === n || (c.aliases as readonly string[]).some((a) => norm(a) === n)) {
        out[c.key] = i;
        if (n === 'tested by and date' || n === 'tested by date') out.date = i;
        return;
      }
    }
  });
  return out;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return v.result === undefined || v.result === null ? '' : String(v.result);
    if ('hyperlink' in v) return String(v.hyperlink);
  }
  return String(v).trim();
}

export function parseStatus(s: string): CaseStatus | null {
  const n = norm(s);
  if (!n) return null;
  if (n.startsWith('pass')) return 'PASS';
  if (n.startsWith('fail')) return 'FAIL';
  if (n.startsWith('block')) return 'BLOCKED';
  if (n === 'not run' || n === 'notrun' || n === 'not tested') return 'NOT_RUN';
  return null;
}

/** Accepts ISO, dd-mm-yyyy and dd/mm/yyyy, with optional time. */
export function parseDate(s: string): Date | null {
  if (!s) return null;
  const m = s.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T]+(\d{1,2}):(\d{2}))?/);
  if (m) {
    const [, dd, mm, yyyy, hh = '12', mi = '00'] = m;
    const d = new Date(`${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${hh.padStart(2, '0')}:${mi}:00+05:30`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface ParsedRow {
  row: number;
  values: Partial<Record<ColKey, string>>;
}

export async function readTracker(buf: Buffer): Promise<{ rows: ParsedRow[]; warnings: string[] }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw badRequest('Could not read that file. Upload an .xlsx tracker');
  }
  const ws = wb.worksheets.find((w) => norm(w.name) === 'test cases') ?? wb.worksheets.find((w) => /case/i.test(w.name));
  if (!ws) throw badRequest('No "Test Cases" sheet found');
  const warnings: string[] = [];
  let headerRow = 1;
  let map: Partial<Record<ColKey, number>> = {};
  for (let r = 1; r <= Math.min(10, ws.rowCount); r++) {
    const vals = (ws.getRow(r).values as ExcelJS.CellValue[]).slice(1).map(cellText);
    map = mapHeaders(vals);
    if (map.caseKey !== undefined && map.title !== undefined) {
      headerRow = r;
      break;
    }
  }
  if (map.caseKey === undefined || map.title === undefined) throw badRequest('Could not find the ID and Scenario/Title columns');
  if (map.module === undefined) warnings.push('No Module column. Cases go under "General"');
  const rows: ParsedRow[] = [];
  ws.eachRow((row, rn) => {
    if (rn <= headerRow) return;
    const vals = (row.values as ExcelJS.CellValue[]).slice(1);
    const values: Partial<Record<ColKey, string>> = {};
    for (const [k, idx] of Object.entries(map) as [ColKey, number][]) values[k] = cellText(vals[idx]);
    if (!values.caseKey) return;
    rows.push({ row: rn, values });
  });
  return { rows, warnings };
}

const clip = (s: string | undefined, n: number) => (s ? s.slice(0, n) : null);

/** Imports tracker rows into the project's case template (upsert by Test ID). */
export async function importTemplate(user: AuthUser, projectId: string, buf: Buffer) {
  const { rows, warnings } = await readTracker(buf);
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const seen = new Set<string>();
  await prisma.$transaction(
    async (tx) => {
      for (const [i, r] of rows.entries()) {
        const v = r.values;
        const key = v.caseKey!.trim();
        if (seen.has(key)) {
          warnings.push(`Row ${r.row}: duplicate ID ${key} skipped`);
          skipped++;
          continue;
        }
        seen.add(key);
        if (!v.title) {
          warnings.push(`Row ${r.row}: ${key} has no title, skipped`);
          skipped++;
          continue;
        }
        const data = {
          module: clip(v.module, 200) || 'General',
          title: clip(v.title, 1000)!,
          role: clip(v.role, 200),
          path: clip(v.path, 1000),
          priority: clip(v.priority, 10) || 'P2',
          type: clip(v.type, 40) || 'Functional',
          preconditions: clip(v.preconditions, 5000),
          steps: clip(v.steps, 10000),
          expected: clip(v.expected, 10000),
          testData: clip(v.testData, 5000),
          sortOrder: i,
        };
        const ex = await tx.templateCase.findUnique({ where: { projectId_caseKey: { projectId, caseKey: key } } });
        if (ex) {
          await tx.templateCase.update({ where: { id: ex.id }, data });
          updated++;
        } else {
          await tx.templateCase.create({ data: { projectId, caseKey: key, ...data } });
          created++;
        }
      }
      await audit(tx, user, { projectId, action: 'template.imported', entity: 'project', entityId: projectId, data: { created, updated, skipped } });
    },
    { timeout: 60_000 },
  );
  return { created, updated, skipped, warnings };
}

/** Imports results from a filled tracker into a run. Only rows with a status are used. */
export async function importResults(user: AuthUser, runId: string, buf: Buffer) {
  const { rows, warnings } = await readTracker(buf);
  let updated = 0;
  let skipped = 0;
  await prisma.$transaction(
    async (tx) => {
      const run = await assertUnlocked(tx, runId);
      const cases = await tx.runCase.findMany({ where: { runId } });
      const byKey = new Map(cases.map((c) => [c.caseKey, c]));
      let seq = (await tx.project.findUniqueOrThrow({ where: { id: run.projectId } })).defectSeq;
      for (const r of rows) {
        const v = r.values;
        const status = parseStatus(v.finalStatus || v.status || '');
        const rc = byKey.get(v.caseKey!.trim());
        if (!rc) {
          if (status) warnings.push(`Row ${r.row}: ${v.caseKey} is not in this run`);
          skipped++;
          continue;
        }
        if (!status || status === 'NOT_RUN') {
          skipped++;
          continue;
        }
        const testedAt = parseDate(v.retestedAt || v.date || v.tester || '') ?? new Date();
        const testerName = (v.retestedBy || v.tester || '').replace(/\d{1,2}[-/.]\d{1,2}[-/.]\d{4}.*$/, '').trim() || user.name;
        await tx.runCase.update({
          where: { id: rc.id },
          data: { status, actualResult: clip(v.actual, 2000), testedByName: testerName, testedAt, version: { increment: 1 } },
        });
        await tx.caseEvent.create({
          data: {
            runCaseId: rc.id,
            kind: 'import',
            status,
            note: clip(v.actual, 2000),
            actorId: user.id,
            actorName: testerName,
            data: { source: 'xlsx', row: r.row, importedBy: user.name },
          },
        });
        const hadFail = parseStatus(v.status || '') === 'FAIL' || Boolean(v.defectId) || Boolean(v.failureNotes);
        if (hadFail) {
          const m = (v.defectId || '').match(/^DEF-(\d+)$/i);
          let code: string;
          let number: number;
          if (m && !(await tx.defect.findUnique({ where: { projectId_code: { projectId: run.projectId, code: m[1] ? `DEF-${m[1].padStart(3, '0')}` : '' } } }))) {
            number = Number(m[1]);
            code = `DEF-${m[1].padStart(3, '0')}`;
            seq = Math.max(seq, number);
          } else {
            number = ++seq;
            code = `DEF-${String(number).padStart(3, '0')}`;
          }
          const retest = parseStatus(v.retestResult || '');
          const defStatus = retest === 'PASS' ? 'RETEST_PASSED' : retest === 'FAIL' ? 'RETEST_FAILED' : v.fixRef ? 'FIXED' : status === 'FAIL' ? 'OPEN' : 'CLOSED';
          await tx.defect.create({
            data: {
              projectId: run.projectId,
              runId,
              runCaseId: rc.id,
              code,
              number,
              title: `${rc.caseKey}: ${rc.title}`.slice(0, 1000),
              note: clip(v.failureNotes || v.actual, 5000),
              severity: rc.priority,
              status: defStatus,
              reportedById: user.id,
              fixRef: clip(v.fixRef, 500),
              fixedByName: clip(v.fixedBy, 120),
              fixedAt: parseDate(v.fixedAt || ''),
              retestResult: retest && retest !== 'NOT_RUN' ? retest : null,
              retestedBy: clip(v.retestedBy, 120),
              retestedAt: parseDate(v.retestedAt || ''),
            },
          });
          if (defStatus === 'FIXED') await tx.runCase.update({ where: { id: rc.id }, data: { needsRetest: true } });
        }
        updated++;
      }
      await tx.project.update({ where: { id: run.projectId }, data: { defectSeq: seq } });
      await audit(tx, user, { runId, projectId: run.projectId, action: 'results.imported', entity: 'run', entityId: runId, data: { updated, skipped } });
    },
    { timeout: 120_000 },
  );
  publish(runId, 'run', runId);
  return { created: 0, updated, skipped, warnings };
}

function styleHeader(ws: ExcelJS.Worksheet, rowNo = 1) {
  const row = ws.getRow(rowNo);
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    c.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    c.alignment = { vertical: 'middle', wrapText: true };
  });
  row.height = 30;
}

function bodyStyle(ws: ExcelJS.Worksheet, from: number) {
  ws.eachRow((row, rn) => {
    if (rn < from) return;
    row.eachCell({ includeEmpty: false }, (c) => {
      c.font = { name: 'Calibri', size: 11, ...(c.font?.bold ? { bold: true } : {}), ...(c.font?.color ? { color: c.font.color } : {}) };
      c.alignment = { vertical: 'top', wrapText: true };
    });
  });
}

type DV = { add(range: string, v: ExcelJS.DataValidation): void };
function list(ws: ExcelJS.Worksheet, range: string, values: string[]) {
  (ws as unknown as { dataValidations: DV }).dataValidations.add(range, {
    type: 'list',
    allowBlank: true,
    formulae: [`"${values.join(',')}"`],
  });
}
function dateDv(ws: ExcelJS.Worksheet, range: string) {
  (ws as unknown as { dataValidations: DV }).dataValidations.add(range, {
    type: 'date',
    operator: 'greaterThan',
    allowBlank: true,
    formulae: [new Date(Date.UTC(2020, 0, 1))],
  });
}

const titleCell = (ws: ExcelJS.Worksheet, text: string) => {
  ws.getCell('A1').value = text;
  ws.getCell('A1').font = { name: 'Calibri', size: 14, bold: true, color: { argb: NAVY } };
};

const STATUSES = ['Pass', 'Fail', 'Blocked', 'Not run'];
const asDate = (d: Date | null | undefined) => (d ? new Date(d) : null);

/** Exports a run in the tracker template: same sheets, columns and styles. */
export async function exportRun(runId: string): Promise<Buffer> {
  const run = await prisma.run.findUniqueOrThrow({
    where: { id: runId },
    include: {
      project: true,
      cases: { orderBy: { sortOrder: 'asc' } },
      defects: { orderBy: { number: 'asc' }, include: { runCase: { select: { caseKey: true, module: true } }, reportedBy: { select: { name: true } }, assignee: { select: { name: true } } } },
      signOffs: { orderBy: { signedAt: 'asc' } },
    },
  });
  const appName = run.project.name;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VAICS Consulting';
  wb.created = new Date();

  // Instructions
  const ins = wb.addWorksheet('Instructions', { views: [{ state: 'frozen', ySplit: 2 }] });
  ins.columns = [{ width: 26 }, { width: 110 }];
  titleCell(ins, `${appName} - Test Tracker (${run.environment})`);
  const insRows: [string, string][] = [
    ['Run', run.name],
    ['How to record a result', 'Fill Status (Pass / Fail / Blocked / Not run from the dropdown), Actual Result, Tester and Date.'],
    ['How to log a Fail', 'Set Status to Fail. Fill Defect/Bug ID and Failure notes on the Test Cases sheet and add a row in the Defect Log.'],
    ['How to retest', 'After a fix, fill Fixed by, Fixed at and Fix reference, then Retest result, Retested by and Retested at. Final status is the latest result.'],
    ['Priority', 'P1 = must pass before client hand-over; P2 = important; P3 = nice to have.'],
    ['Type', 'Functional, Security, UI, Negative, E2E.'],
    ['Summary and sign-off', 'The Summary sheet counts update from the Status column. Sign off on the Sign-off sheet.'],
    ['Exported from', `VAICS UAT on ${fmtDateTime(new Date())} (Asia/Calcutta)`],
  ];
  insRows.forEach(([a, b], i) => {
    ins.getCell(`A${i + 3}`).value = a;
    ins.getCell(`B${i + 3}`).value = b;
    ins.getCell(`A${i + 3}`).font = { name: 'Calibri', bold: true };
  });
  const tr = insRows.length + 3;
  ins.getCell(`A${tr}`).value = 'Total test cases';
  ins.getCell(`A${tr}`).font = { name: 'Calibri', bold: true };
  ins.getCell(`B${tr}`).value = { formula: "COUNTA('Test Cases'!A2:A500)" };
  bodyStyle(ins, 3);

  // Environment & Setup
  const env = wb.addWorksheet('Environment & Setup', { views: [{ state: 'frozen', ySplit: 1 }] });
  env.columns = [
    { header: 'Area', width: 18 },
    { header: 'Item', width: 36 },
    { header: 'Details', width: 72 },
    { header: 'Value / Notes (fill in)', width: 64 },
    { header: 'Ready (Yes/No)', width: 14 },
  ];
  const envRows = [
    ['Access', `${appName} URL for this run`, 'Deployed app address used for this run', run.baseUrl ?? '', ''],
    ['Build', 'Build / version', 'Build tag under test', run.buildTag ?? '', ''],
    ['Environment', 'Environment', 'Where the run happens', run.environment, ''],
    ['Run', 'Run name', 'Name of this test run', run.name, ''],
    ['Client', 'Client', 'Client the report is for', run.clientName ?? '', ''],
  ];
  envRows.forEach((r) => env.addRow(r));
  styleHeader(env);
  bodyStyle(env, 2);
  env.autoFilter = { from: 'A1', to: `E${envRows.length + 1}` };
  list(env, `E2:E${Math.max(29, envRows.length + 1)}`, ['Yes', 'No']);

  // Test Cases
  const tc = wb.addWorksheet('Test Cases', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  tc.columns = CASE_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  for (const c of run.cases) {
    const defs = run.defects.filter((x) => x.runCaseId === c.id);
    const last = defs[defs.length - 1];
    tc.addRow({
      caseKey: c.caseKey,
      module: c.module,
      role: c.role,
      path: c.path,
      title: c.title,
      preconditions: c.preconditions,
      steps: c.steps,
      testData: c.testData,
      expected: c.expected,
      priority: c.priority,
      type: c.type,
      status: STATUS_LABEL[c.status],
      actual: c.actualResult,
      tester: c.testedByName,
      date: asDate(c.testedAt),
      remarks: null,
      needsConfirmation: null,
      defectId: defs.map((x) => x.code).join(', ') || null,
      failureNotes: last?.note ?? null,
      fixedBy: last?.fixedByName ?? null,
      fixedAt: asDate(last?.fixedAt),
      fixRef: last?.fixRef ?? null,
      retestResult: last?.retestResult ? STATUS_LABEL[last.retestResult] : null,
      retestedBy: last?.retestedBy ?? null,
      retestedAt: asDate(last?.retestedAt),
      finalStatus: c.status === 'NOT_RUN' ? null : STATUS_LABEL[c.status],
    });
  }
  styleHeader(tc);
  bodyStyle(tc, 2);
  for (const k of ['date', 'fixedAt', 'retestedAt']) tc.getColumn(k).numFmt = 'dd-mm-yyyy';
  tc.autoFilter = { from: 'A1', to: { row: run.cases.length + 1, column: CASE_COLUMNS.length } };
  list(tc, 'L2:L500', STATUSES);
  list(tc, 'W2:W500', STATUSES);
  list(tc, 'Z2:Z500', STATUSES);
  list(tc, 'J2:J500', ['P1', 'P2', 'P3']);
  list(tc, 'K2:K500', ['Functional', 'Security', 'UI', 'Negative', 'E2E']);
  dateDv(tc, 'O2:O500');
  dateDv(tc, 'U2:U500');
  dateDv(tc, 'Y2:Y500');

  // Summary
  const sm = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 1 }] });
  sm.columns = [
    { header: 'Module', width: 36 },
    { header: 'Total', width: 13 },
    { header: 'Pass', width: 13 },
    { header: 'Fail', width: 13 },
    { header: 'Blocked', width: 13 },
    { header: 'Not run', width: 13 },
    { header: '% Pass (of run)', width: 16 },
    { header: '% Done', width: 12 },
  ];
  const modules = [...new Set(run.cases.map((c) => c.module))];
  const R = "'Test Cases'!$B$2:$B$500";
  const S = "'Test Cases'!$L$2:$L$500";
  modules.forEach((m, i) => {
    const r = i + 2;
    sm.addRow([
      m,
      { formula: `COUNTIF(${R},A${r})` },
      { formula: `COUNTIFS(${R},$A${r},${S},"Pass")` },
      { formula: `COUNTIFS(${R},$A${r},${S},"Fail")` },
      { formula: `COUNTIFS(${R},$A${r},${S},"Blocked")` },
      { formula: `B${r}-C${r}-D${r}-E${r}` },
      { formula: `IF(C${r}+D${r}+E${r}=0,"",C${r}/(C${r}+D${r}+E${r}))` },
      { formula: `IF(B${r}=0,"",(C${r}+D${r}+E${r})/B${r})` },
    ]);
  });
  const t = modules.length + 2;
  sm.addRow([
    'Total',
    { formula: `SUM(B2:B${t - 1})` },
    { formula: `SUM(C2:C${t - 1})` },
    { formula: `SUM(D2:D${t - 1})` },
    { formula: `SUM(E2:E${t - 1})` },
    { formula: `SUM(F2:F${t - 1})` },
    { formula: `IF(C${t}+D${t}+E${t}=0,"",C${t}/(C${t}+D${t}+E${t}))` },
    { formula: `IF(B${t}=0,"",(C${t}+D${t}+E${t})/B${t})` },
  ]);
  styleHeader(sm);
  bodyStyle(sm, 2);
  sm.getRow(t).font = { name: 'Calibri', bold: true };
  sm.getColumn(7).numFmt = '0%';
  sm.getColumn(8).numFmt = '0%';

  // Defect Log
  const dl = wb.addWorksheet('Defect Log', { views: [{ state: 'frozen', ySplit: 1 }] });
  dl.columns = [
    ['Defect ID', 14], ['Test ID', 12], ['Module', 28], ['Summary', 40], ['Severity', 12], ['Status', 14], ['Reported by', 16], ['Reported at', 14],
    ['Failure notes', 44], ['Assigned to', 16], ['Fix reference', 24], ['Fixed at', 14], ['Retest result', 14], ['Retested by', 14], ['Retested at', 14], ['Final status', 14],
  ].map(([header, width]) => ({ header: header as string, width: width as number }));
  for (const x of run.defects) {
    dl.addRow([
      x.code, x.runCase.caseKey, x.runCase.module, x.title, x.severity, DEFECT_LABEL[x.status], x.reportedBy?.name ?? null, asDate(x.createdAt),
      x.note, x.assignee?.name ?? null, x.fixRef, asDate(x.fixedAt), x.retestResult ? STATUS_LABEL[x.retestResult] : null, x.retestedBy, asDate(x.retestedAt),
      x.status === 'RETEST_PASSED' || x.status === 'CLOSED' ? 'Pass' : x.status === 'RETEST_FAILED' ? 'Fail' : null,
    ]);
  }
  styleHeader(dl);
  bodyStyle(dl, 2);
  for (const c of [8, 12, 15]) dl.getColumn(c).numFmt = 'dd-mm-yyyy';
  const dlEnd = Math.max(80, run.defects.length + 1);
  dl.autoFilter = { from: 'A1', to: `P${dlEnd}` };
  list(dl, `E2:E${dlEnd}`, ['P1', 'P2', 'P3']);
  list(dl, `F2:F${dlEnd}`, ['Open', 'Fixed', 'Retest passed', 'Retest failed', 'Closed']);
  list(dl, `M2:M${dlEnd}`, STATUSES);
  list(dl, `P2:P${dlEnd}`, STATUSES);

  // Automated Checks (kept for template parity)
  const ac = wb.addWorksheet('Automated Checks', { views: [{ state: 'frozen', ySplit: 3 }] });
  titleCell(ac, 'Automated checks');
  ac.columns = [{ width: 12 }, { width: 22 }, { width: 36 }, { width: 44 }, { width: 10 }, { width: 72 }, { width: 28 }, { width: 22 }];
  ac.getRow(3).values = ['Check ID', 'Area', 'Check', 'How it was run', 'Result', 'Evidence / notes', 'When (Asia/Calcutta)', 'Method'];
  styleHeader(ac, 3);
  ac.autoFilter = { from: 'A3', to: 'H13' };
  list(ac, 'E4:E13', STATUSES);

  // Sign-off
  const so = wb.addWorksheet('Sign-off', { views: [{ state: 'frozen', ySplit: 2 }] });
  so.columns = [{ width: 28 }, { width: 28 }, { width: 20 }, { width: 16 }, { width: 50 }];
  titleCell(so, `${appName} test tracker sign-off`);
  const info: [string, string][] = [
    ['Product', `${appName} (${run.environment})`],
    ['App URL', run.baseUrl ?? ''],
    ['Run', run.name],
    ['Build / version', run.buildTag ?? ''],
    ['Report ID', run.reportId ?? ''],
    ['Report hash', run.reportHash ?? 'Not signed off'],
    ['Exported on', `${fmtDate(new Date())}, Asia/Calcutta`],
  ];
  info.forEach(([a, b], i) => {
    so.getCell(`A${i + 3}`).value = a;
    so.getCell(`A${i + 3}`).font = { name: 'Calibri', bold: true };
    so.getCell(`B${i + 3}`).value = b;
  });
  const hr = info.length + 4;
  so.getRow(hr).values = ['Role', 'Name', 'Date (dd-mm-yyyy)', 'Result', 'Notes'];
  styleHeader(so, hr);
  const signRows: (string | null)[][] = run.signOffs.length
    ? run.signOffs.map((s) => [s.role, s.name, fmtDate(s.signedAt), 'Signed off', s.company])
    : ['Prepared by', 'Tested by', 'Reviewed by', 'Approved by'].map((r) => [r, null, null, null, null]);
  signRows.forEach((r, i) => (so.getRow(hr + 1 + i).values = r));
  list(so, `D${hr + 1}:D${hr + signRows.length}`, [...STATUSES, 'Signed off']);
  so.getCell(`A${hr + signRows.length + 2}`).value = 'Sign-off rule';
  so.getCell(`A${hr + signRows.length + 2}`).font = { name: 'Calibri', bold: true };
  so.getCell(`B${hr + signRows.length + 2}`).value = 'Sign off only after P1 cases are complete and open defects are agreed.';

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/** Exports a project's template as an empty tracker. */
export async function exportTemplate(projectId: string): Promise<Buffer> {
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { cases: { orderBy: { sortOrder: 'asc' } } } });
  const wb = new ExcelJS.Workbook();
  const tc = wb.addWorksheet('Test Cases', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  tc.columns = CASE_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  for (const c of p.cases) {
    tc.addRow({ caseKey: c.caseKey, module: c.module, role: c.role, path: c.path, title: c.title, preconditions: c.preconditions, steps: c.steps, testData: c.testData, expected: c.expected, priority: c.priority, type: c.type });
  }
  styleHeader(tc);
  bodyStyle(tc, 2);
  tc.autoFilter = { from: 'A1', to: { row: p.cases.length + 1, column: CASE_COLUMNS.length } };
  list(tc, 'L2:L500', STATUSES);
  list(tc, 'J2:J500', ['P1', 'P2', 'P3']);
  list(tc, 'K2:K500', ['Functional', 'Security', 'UI', 'Negative', 'E2E']);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

