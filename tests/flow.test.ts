import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { prisma } from '../src/db';
import { PNG, api, makeUser, resetDb } from './helpers';

type H = Record<string, string>;
let admin: { auth: H; user: { id: string } };
let tester: { auth: H };
let tester2: { auth: H };
let dev: { auth: H; user: { id: string } };
let viewer: { auth: H };
let projectId: string;
let runId: string;

async function trackerXlsx(rows: (string | null)[][], headers?: string[]) {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Instructions');
  const ws = wb.addWorksheet('Test Cases');
  ws.addRow(headers ?? ['Test ID', 'Module', 'Role', 'Page/Route', 'Scenario', 'Preconditions', 'Steps', 'Test Data', 'Expected Result', 'Priority', 'Type', 'Status', 'Actual Result', 'Tester', 'Date']);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

beforeAll(async () => {
  await resetDb();
  admin = await makeUser('ADMIN', 'Asha');
  tester = await makeUser('TESTER', 'Ravi');
  tester2 = await makeUser('TESTER', 'Meena');
  dev = await makeUser('DEVELOPER', 'Dev');
  viewer = await makeUser('VIEWER', 'Viewer');
});
afterAll(async () => prisma.$disconnect());

describe('health and auth', () => {
  it('health is ok', async () => {
    const r = await api().get('/health').expect(200);
    expect(r.body).toMatchObject({ status: 'ok', db: 'ok', storage: 'local' });
  });
  it('rejects bad password and missing token', async () => {
    await api().post('/auth/login').send({ email: 'asha@test.local', password: 'nope' }).expect(401);
    await api().get('/projects').expect(401);
  });
  it('invite flow creates a user who can sign in', async () => {
    const inv = await api().post('/auth/invites').set(admin.auth).send({ email: 'new@test.local', role: 'TESTER' }).expect(201);
    const token = String(inv.body.inviteUrl).split('/invite/')[1];
    await api().get(`/auth/invites/${token}`).expect(200);
    const acc = await api().post('/auth/accept-invite').send({ token, name: 'New One', password: 'longpassword' }).expect(201);
    expect(acc.body.user.role).toBe('TESTER');
    await api().get(`/auth/invites/${token}`).expect(404);
    await api().post('/auth/invites').set(tester.auth).send({ email: 'x@test.local' }).expect(403);
  });
});

describe('projects, template import and runs', () => {
  it('admin creates a project, viewer cannot', async () => {
    await api().post('/projects').set(viewer.auth).send({ key: 'VV', name: 'V-Vault' }).expect(403);
    const r = await api().post('/projects').set(admin.auth).send({ key: 'VV', name: 'V-Vault', devBaseUrl: 'https://vv.example.com', clientName: 'Acme' }).expect(201);
    projectId = r.body.id;
  });
  it('imports an xlsx tracker with loose headers', async () => {
    const buf = await trackerXlsx(
      [
        ['VV-001', 'Access', 'All', '/', 'Launch app', null, '1. Open', null, 'Opens', 'P1', 'Functional'],
        ['VV-002', 'Access', 'All', '/files', 'Open files', null, '1. Click', null, 'Shows files', 'P1', 'Functional'],
        ['VV-003', 'Upload', 'Admin', '/files', 'Upload a file', null, '1. Upload', null, 'Uploaded', 'P2', 'E2E'],
      ],
      ['test id', 'MODULE', 'Role', 'Page / Route', 'Title', 'Preconditions', 'Steps', 'Test data', 'Expected', 'Priority', 'Type'],
    );
    const r = await api().post(`/projects/${projectId}/import`).set(admin.auth).attach('file', buf, 'tracker.xlsx').expect(200);
    expect(r.body).toMatchObject({ created: 3, updated: 0 });
    const again = await api().post(`/projects/${projectId}/import`).set(admin.auth).attach('file', buf, 'tracker.xlsx').expect(200);
    expect(again.body).toMatchObject({ created: 0, updated: 3 });
  });
  it('a run snapshots the template', async () => {
    const r = await api().post(`/projects/${projectId}/runs`).set(tester.auth).send({ name: 'UAT round 1', environment: 'dev', buildTag: 'fe@abc123' }).expect(201);
    runId = r.body.id;
    expect(r.body).toMatchObject({ total: 3, done: 0, baseUrl: 'https://vv.example.com', clientName: 'Acme' });
    expect(r.body.reportId).toMatch(/^UAT-VV-\d{8}-[A-Z0-9]{4}$/);
    await api().patch(`/projects/${projectId}/cases/${(await prisma.templateCase.findFirstOrThrow({ where: { caseKey: 'VV-001' } })).id}`).set(admin.auth).send({ title: 'Changed later' }).expect(200);
    const cases = await api().get(`/runs/${runId}/cases`).set(viewer.auth).expect(200);
    expect(cases.body[0].title).toBe('Launch app');
  });
});

describe('testing, defects and retest', () => {
  let c1: { id: string; version: number };
  let c2: { id: string; version: number };
  let defectId: string;

  it('pass with a screenshot via presigned upload', async () => {
    const cases = (await api().get(`/runs/${runId}/cases`).set(tester.auth)).body;
    [c1, c2] = cases;
    const pre = await api().post(`/cases/${c1.id}/attachments`).set(tester.auth).send({ fileName: 'shot.png', mimeType: 'image/png', size: PNG.length }).expect(201);
    const u = new URL(pre.body.upload.url);
    await api().put(u.pathname + u.search).set('Content-Type', 'image/png').send(PNG).expect(200);
    const att = await api().post(`/attachments/${pre.body.attachmentId}/confirm`).set(tester.auth).expect(200);
    expect(att.body.size).toBe(PNG.length);
    const r = await api().post(`/cases/${c1.id}/result`).set(tester.auth).send({ status: 'PASS', version: c1.version, attachmentIds: [pre.body.attachmentId] }).expect(200);
    expect(r.body.case).toMatchObject({ status: 'PASS', testedBy: 'Ravi', version: 1 });
    expect(r.body.case.attachments).toHaveLength(1);
    const v = new URL(r.body.case.attachments[0].url);
    const img = await api().get(v.pathname + v.search).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
  });

  it('rejects a stale version with 409', async () => {
    await api().post(`/cases/${c1.id}/result`).set(tester2.auth).send({ status: 'FAIL', version: 0 }).expect(409);
  });

  it('viewer and developer cannot record results', async () => {
    await api().post(`/cases/${c2.id}/result`).set(viewer.auth).send({ status: 'PASS', version: 0 }).expect(403);
    await api().post(`/cases/${c2.id}/result`).set(dev.auth).send({ status: 'PASS', version: 0 }).expect(403);
  });

  it('fail opens DEF-001 straight away', async () => {
    const r = await api().post(`/cases/${c2.id}/result`).set(tester.auth).send({ status: 'FAIL', actualResult: 'List is empty', version: 0 }).expect(200);
    expect(r.body.defect).toMatchObject({ code: 'DEF-001', status: 'OPEN', caseKey: 'VV-002', note: 'List is empty' });
    defectId = r.body.defect.id;
    expect(r.body.case.openDefect.code).toBe('DEF-001');
  });

  it('assign, fix, retest prompt, retest pass', async () => {
    let d = (await api().patch(`/defects/${defectId}`).set(admin.auth).send({ version: 0, assigneeId: dev.user.id }).expect(200)).body;
    expect(d.assignee.name).toBe('Dev');
    await api().post(`/defects/${defectId}/fix`).set(tester.auth).send({ version: d.version, fixRef: 'PR #12' }).expect(403);
    d = (await api().post(`/defects/${defectId}/fix`).set(dev.auth).send({ version: d.version, fixRef: 'PR #12' }).expect(200)).body;
    expect(d).toMatchObject({ status: 'FIXED', fixRef: 'PR #12', fixedBy: 'Dev' });
    const c = (await api().get(`/cases/${c2.id}`).set(tester.auth)).body;
    expect(c.needsRetest).toBe(true);
    const s1 = (await api().get(`/runs/${runId}/stats`).set(tester.auth)).body;
    expect(s1.needsRetest).toBe(1);
    // retest fails first
    let r = await api().post(`/cases/${c2.id}/result`).set(tester2.auth).send({ status: 'FAIL', actualResult: 'Still empty', version: c.version }).expect(200);
    expect(r.body.retest).toBe(true);
    expect(r.body.defect).toMatchObject({ code: 'DEF-001', status: 'RETEST_FAILED', retestedBy: 'Meena' });
    d = (await api().post(`/defects/${defectId}/fix`).set(dev.auth).send({ version: r.body.defect.version, fixRef: 'PR #13' }).expect(200)).body;
    const c3 = (await api().get(`/cases/${c2.id}`).set(tester.auth)).body;
    r = await api().post(`/cases/${c2.id}/result`).set(tester2.auth).send({ status: 'PASS', version: c3.version }).expect(200);
    expect(r.body.defect.status).toBe('RETEST_PASSED');
    expect(r.body.case.needsRetest).toBe(false);
  });

  it('history is append-only and complete', async () => {
    const h = (await api().get(`/cases/${c2.id}/history`).set(viewer.auth).expect(200)).body as { kind: string; status: string | null }[];
    expect(h.map((e) => e.kind)).toEqual(['result', 'defect_opened', 'fixed', 'retest', 'fixed', 'retest']);
    expect(h.map((e) => e.status)).toEqual(['FAIL', null, null, 'FAIL', null, 'PASS']);
  });

  it('dashboard stats add up', async () => {
    const s = (await api().get(`/runs/${runId}/stats`).set(viewer.auth).expect(200)).body;
    expect(s).toMatchObject({ total: 3, pass: 2, fail: 0, notRun: 1, done: 2, passRate: 100, openDefects: 0 });
    expect(s.modules.find((m: { module: string }) => m.module === 'Access')).toMatchObject({ total: 2, pass: 2 });
    expect(s.testers.map((t: { name: string }) => t.name).sort()).toEqual(['Meena', 'Ravi']);
  });
});

describe('export, import results, report, share, sign-off', () => {
  it('exports the tracker template with all sheets and styles', async () => {
    const r = await api().get(`/runs/${runId}/export`).set(viewer.auth).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Instructions', 'Environment & Setup', 'Test Cases', 'Summary', 'Defect Log', 'Automated Checks', 'Sign-off']);
    const tc = wb.getWorksheet('Test Cases')!;
    expect(tc.getCell('A1').value).toBe('Test ID');
    expect(tc.getCell('Z1').value).toBe('Final status');
    expect((tc.getCell('A1').fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FF0D47A1');
    expect(tc.getCell('A1').font.bold).toBe(true);
    expect(tc.getCell('L3').value).toBe('Pass');
    expect(tc.getCell('R3').value).toBe('DEF-001');
    expect(wb.getWorksheet('Defect Log')!.getCell('A2').value).toBe('DEF-001');
    expect(String((wb.getWorksheet('Summary')!.getCell('C2').value as { formula: string }).formula)).toContain('COUNTIFS');
  });

  it('imports results from a filled tracker', async () => {
    const buf = await trackerXlsx([['VV-003', 'Upload', null, null, 'Upload a file', null, null, null, null, 'P2', 'E2E', 'Blocked', 'Storage down', 'Kiran', '24-11-2026']]);
    const r = await api().post(`/runs/${runId}/import-results`).set(tester.auth).attach('file', buf, 'filled.xlsx').expect(200);
    expect(r.body.updated).toBe(1);
    const c = (await api().get(`/runs/${runId}/cases`).set(tester.auth)).body.find((x: { caseKey: string }) => x.caseKey === 'VV-003');
    expect(c).toMatchObject({ status: 'BLOCKED', testedBy: 'Kiran', actualResult: 'Storage down' });
  });

  it('builds the report and a PDF', async () => {
    const rep = (await api().get(`/runs/${runId}/report`).set(viewer.auth).expect(200)).body;
    expect(rep.client.name).toBe('Acme');
    expect(rep.cases).toHaveLength(3);
    expect(rep.defects[0].code).toBe('DEF-001');
    const pdf = await api().get(`/runs/${runId}/report.pdf`).set(viewer.auth).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('share links expire and can be revoked', async () => {
    await api().post(`/runs/${runId}/share-links`).set(tester.auth).send({ label: 'Acme' }).expect(403);
    const l = (await api().post(`/runs/${runId}/share-links`).set(admin.auth).send({ label: 'Acme', expiresInDays: 7 }).expect(201)).body;
    const token = String(l.url).split('/audit/')[1];
    const pub = await api().get(`/public/audit/${token}`).expect(200);
    expect(pub.body.project.key).toBe('VV');
    await prisma.shareLink.update({ where: { id: l.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await api().get(`/public/audit/${token}`).expect(404);
    const l2 = (await api().post(`/runs/${runId}/share-links`).set(admin.auth).send({ label: 'Acme 2' }).expect(201)).body;
    const t2 = String(l2.url).split('/audit/')[1];
    await api().get(`/public/audit/${t2}/pdf`).expect(200);
    await api().delete(`/share-links/${l2.id}`).set(admin.auth).expect(204);
    await api().get(`/public/audit/${t2}`).expect(404);
  });

  it('sign-off locks the run and stores a hash', async () => {
    await api().post(`/runs/${runId}/signoff`).set(tester.auth).send({ signers: [{ name: 'A', role: 'QA' }], confirm: true }).expect(403);
    const r = (await api().post(`/runs/${runId}/signoff`).set(admin.auth).send({ signers: [{ name: 'Asha', role: 'QA lead', company: 'VAICS Consulting' }, { name: 'Client PM', role: 'Approver', company: 'Acme' }], confirm: true }).expect(200)).body;
    expect(r.status).toBe('SIGNED_OFF');
    expect(r.reportHash).toMatch(/^[a-f0-9]{64}$/);
    const c = (await api().get(`/runs/${runId}/cases`).set(tester.auth)).body[0];
    await api().post(`/cases/${c.id}/result`).set(tester.auth).send({ status: 'FAIL', version: c.version }).expect(423);
    await api().patch(`/runs/${runId}`).set(admin.auth).send({ name: 'x' }).expect(423);
    await api().post(`/cases/${c.id}/attachments`).set(tester.auth).send({ fileName: 'a.png', mimeType: 'image/png', size: 10 }).expect(423);
    const log = (await api().get(`/runs/${runId}/audit-log`).set(viewer.auth).expect(200)).body as { action: string }[];
    const actions = log.map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['run.created', 'case.result', 'defect.opened', 'defect.fixed', 'case.retested', 'share_link.created', 'share_link.revoked', 'run.signed_off', 'run.locked']));
    const rep = (await api().get(`/runs/${runId}/report`).set(viewer.auth)).body;
    expect(rep).toMatchObject({ locked: true, reportHash: r.reportHash });
    expect(rep.signOffs).toHaveLength(2);
  });

  it('sign-off is refused while cases are not run', async () => {
    const r = (await api().post(`/projects/${projectId}/runs`).set(admin.auth).send({ name: 'Round 2', environment: 'dev' }).expect(201)).body;
    const res = await api().post(`/runs/${r.id}/signoff`).set(admin.auth).send({ signers: [{ name: 'A', role: 'QA' }], confirm: true }).expect(400);
    expect(res.body.error.message).toContain('not run');
  });
});
