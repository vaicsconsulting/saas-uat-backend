import PDFDocument from 'pdfkit';
import { prisma } from '../db';
import { storage } from '../storage';
import { DEFECT_LABEL, REPORT_TZ, STATUS_LABEL, fmtDate, fmtDateTime } from '../lib/format';
import type { AuditReportData } from './report';

const STATUS_COLOR: Record<string, string> = { PASS: '#1E7B4D', FAIL: '#B42318', BLOCKED: '#B54708', NOT_RUN: '#667085' };
const GREY = '#475467';
const LINE = '#D0D5DD';

async function fetchLogo(url: string | null): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') ?? '';
    if (!/image\/(png|jpe?g)/.test(ct)) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

const isEmbeddable = (mime: string) => /image\/(png|jpe?g)/.test(mime);

/** Renders the client audit report as a PDF buffer. */
export async function renderPdf(report: AuditReportData): Promise<Buffer> {
  const ids = report.cases.flatMap((c) => c.screenshots.map((s) => s.id));
  const rows = ids.length ? await prisma.attachment.findMany({ where: { id: { in: ids } }, select: { id: true, storageKey: true, mimeType: true } }) : [];
  const keyOf = new Map(rows.map((r) => [r.id, r]));
  const logo = await fetchLogo(report.client.logoUrl);
  const navy = report.brand.primary;
  const client = report.client.name ?? 'Client';

  const doc = new PDFDocument({ size: 'A4', margins: { top: 64, bottom: 56, left: 48, right: 48 }, bufferPages: true, info: { Title: `UAT Report ${report.reportId}`, Author: report.brand.company } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  const W = doc.page.width - 96;
  const left = 48;

  // Cover
  doc.rect(0, 0, doc.page.width, 210).fill(navy);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(13).text(report.brand.company.toUpperCase(), left, 48, { characterSpacing: 1.5 });
  doc.font('Helvetica-Bold').fontSize(30).text('UAT Report', left, 92);
  doc.font('Helvetica').fontSize(14).text(`${report.project.name} for ${client}`, left, 136);
  doc.fontSize(10).text(`Prepared by ${report.brand.company}`, left, 162);
  if (logo) {
    try {
      doc.image(logo, doc.page.width - 48 - 120, 60, { fit: [120, 80], align: 'right' });
    } catch {
      /* skip bad logo */
    }
  }
  let y = 250;
  const meta: [string, string][] = [
    ['Client', client],
    ['Application', `${report.project.name} (${report.project.key})`],
    ['Test run', report.run.name],
    ['Environment', report.run.environment],
    ['Build / version', report.run.buildTag ?? 'Not set'],
    ['App URL', report.run.baseUrl ?? 'Not set'],
    ['Test window', `${fmtDate(report.run.windowStart)} to ${report.run.windowEnd ? fmtDate(report.run.windowEnd) : 'ongoing'}`],
    ['Testers', report.testers.join(', ') || 'None yet'],
    ['Report ID', report.reportId],
    ['Status', report.locked ? 'Signed off and locked' : 'Draft, not signed off'],
  ];
  for (const [k, v] of meta) {
    doc.fillColor(GREY).font('Helvetica').fontSize(10).text(k, left, y, { width: 130 });
    doc.fillColor('#101828').font('Helvetica-Bold').fontSize(10).text(v, left + 140, y, { width: W - 140 });
    y = Math.max(doc.y, y + 14) + 8;
  }
  if (report.reportHash) {
    doc.fillColor(GREY).font('Helvetica').fontSize(8).text(`Report hash (SHA-256): ${report.reportHash}`, left, y + 10, { width: W });
  }
  doc.fillColor(GREY).fontSize(8).text(`Generated ${fmtDateTime(report.generatedAt)} (${REPORT_TZ})`, left, doc.page.height - 90, { width: W });

  // Summary
  doc.addPage();
  const h2 = (t: string) => {
    if (doc.y > doc.page.height - 140) doc.addPage();
    doc.moveDown(0.6).fillColor(navy).font('Helvetica-Bold').fontSize(15).text(t, left);
    doc.moveTo(left, doc.y + 2).lineTo(left + W, doc.y + 2).strokeColor(navy).lineWidth(1).stroke();
    doc.moveDown(0.6);
  };
  h2('Summary');
  const s = report.stats;
  const tiles: [string, string][] = [
    ['Total cases', String(s.total)],
    ['Pass', String(s.pass)],
    ['Fail', String(s.fail)],
    ['Blocked', String(s.blocked)],
    ['Not run', String(s.notRun)],
    ['Pass rate', s.passRate === null ? 'n/a' : `${s.passRate}%`],
  ];
  const tw = W / tiles.length;
  const ty = doc.y;
  tiles.forEach(([k, v], i) => {
    doc.rect(left + i * tw + 2, ty, tw - 4, 52).fillAndStroke('#F2F4F7', LINE);
    doc.fillColor('#101828').font('Helvetica-Bold').fontSize(18).text(v, left + i * tw, ty + 8, { width: tw, align: 'center' });
    doc.fillColor(GREY).font('Helvetica').fontSize(8).text(k, left + i * tw, ty + 34, { width: tw, align: 'center' });
  });
  doc.y = ty + 66;
  doc.fillColor('#101828').font('Helvetica').fontSize(10).text(`Open defects: ${s.openDefects}. Done: ${s.percentDone}%.`, left);
  doc.moveDown(0.6);

  const table = (cols: { h: string; w: number; align?: 'left' | 'center' | 'right' }[], data: string[][]) => {
    const drawHead = () => {
      const hy = doc.y;
      doc.rect(left, hy, W, 18).fill(navy);
      let x = left;
      for (const c of cols) {
        doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8.5).text(c.h, x + 4, hy + 5, { width: c.w - 8, align: c.align ?? 'left' });
        x += c.w;
      }
      doc.y = hy + 18;
    };
    drawHead();
    data.forEach((row, ri) => {
      const heights = row.map((v, i) => doc.font('Helvetica').fontSize(8.5).heightOfString(v, { width: cols[i].w - 8 }));
      const rh = Math.max(16, ...heights.map((x) => x + 8));
      if (doc.y + rh > doc.page.height - 60) {
        doc.addPage();
        drawHead();
      }
      const ry = doc.y;
      if (ri % 2) doc.rect(left, ry, W, rh).fill('#F9FAFB');
      let x = left;
      row.forEach((v, i) => {
        doc.fillColor('#101828').font('Helvetica').fontSize(8.5).text(v, x + 4, ry + 4, { width: cols[i].w - 8, align: cols[i].align ?? 'left' });
        x += cols[i].w;
      });
      doc.moveTo(left, ry + rh).lineTo(left + W, ry + rh).strokeColor(LINE).lineWidth(0.5).stroke();
      doc.y = ry + rh;
    });
    doc.x = left;
    doc.moveDown(0.8);
  };
  const n = (w: number) => ({ w, align: 'center' as const });
  table(
    [{ h: 'Module', w: W - 6 * 52 }, { h: 'Total', ...n(52) }, { h: 'Pass', ...n(52) }, { h: 'Fail', ...n(52) }, { h: 'Blocked', ...n(52) }, { h: 'Not run', ...n(52) }, { h: 'Done', ...n(52) }],
    s.modules.map((m) => [m.module, String(m.total), String(m.pass), String(m.fail), String(m.blocked), String(m.notRun), `${m.total ? Math.round(((m.total - m.notRun) / m.total) * 100) : 0}%`]),
  );

  // Cases
  h2('Test cases');
  for (const c of report.cases) {
    const shots = c.screenshots.filter((x) => keyOf.has(x.id));
    const need = 70 + (shots.length ? 150 : 0);
    if (doc.y + need > doc.page.height - 60) doc.addPage();
    const cy = doc.y;
    const color = STATUS_COLOR[c.status] ?? GREY;
    doc.rect(left, cy, 3, 14).fill(color);
    doc.fillColor('#101828').font('Helvetica-Bold').fontSize(10).text(`${c.caseKey}  ${c.title}`, left + 10, cy + 1, { width: W - 90 });
    doc.fillColor(color).font('Helvetica-Bold').fontSize(9).text(STATUS_LABEL[c.status], left + W - 80, cy + 2, { width: 80, align: 'right' });
    doc.fillColor(GREY).font('Helvetica').fontSize(8.5).text(`${c.module} | ${c.priority} | ${c.type}`, left + 10, doc.y + 1, { width: W - 10 });
    if (c.expected) doc.fillColor(GREY).text(`Expected: ${c.expected.replace(/\s*\n\s*/g, ' ')}`, { width: W - 10 });
    doc.fillColor('#101828').text(`Actual: ${c.actualResult || (c.status === 'NOT_RUN' ? 'Not run' : 'As expected')}`, { width: W - 10 });
    const who = c.testedBy ? `Tested by ${c.testedBy} on ${fmtDateTime(c.testedAt)}` : 'Not tested';
    doc.fillColor(GREY).text(`${who}${c.defectCodes.length ? ` | Defects: ${c.defectCodes.join(', ')}` : ''}`, { width: W - 10 });
    if (shots.length) {
      let sx = left + 10;
      let sy = doc.y + 4;
      const bw = (W - 30) / 2;
      for (const sh of shots) {
        const meta2 = keyOf.get(sh.id)!;
        if (!isEmbeddable(meta2.mimeType)) {
          doc.fillColor(GREY).fontSize(8).text(`Screenshot ${sh.fileName} is attached in the app (format not printable).`, left + 10, sy, { width: W - 10 });
          sy = doc.y + 2;
          continue;
        }
        let buf: Buffer;
        try {
          buf = await storage().get(meta2.storageKey);
        } catch {
          continue;
        }
        if (sy + 150 > doc.page.height - 60) {
          doc.addPage();
          sy = doc.y;
          sx = left + 10;
        }
        try {
          doc.image(buf, sx, sy, { fit: [bw, 140] });
          doc.rect(sx, sy, bw, 140).strokeColor(LINE).lineWidth(0.5).stroke();
        } catch {
          continue;
        }
        if (sx === left + 10) sx += bw + 10;
        else {
          sx = left + 10;
          sy += 148;
        }
      }
      doc.y = sx === left + 10 ? sy : sy + 148;
    }
    doc.x = left;
    doc.moveDown(0.3);
    doc.moveTo(left, doc.y).lineTo(left + W, doc.y).strokeColor(LINE).lineWidth(0.5).stroke();
    doc.moveDown(0.5);
  }

  // Defects
  h2('Defects, fixes and retests');
  if (report.defects.length === 0) {
    doc.fillColor(GREY).font('Helvetica').fontSize(10).text('No defects were logged in this run.', left);
  } else {
    table(
      [
        { h: 'ID', w: 52 },
        { h: 'Case', w: 52 },
        { h: 'Summary', w: W - 52 - 52 - 70 - 90 - 90 },
        { h: 'Status', w: 70 },
        { h: 'Fix', w: 90 },
        { h: 'Retest', w: 90 },
      ],
      report.defects.map((x) => [
        x.code,
        x.caseKey,
        `${x.title}${x.note ? `\n${x.note}` : ''}`,
        DEFECT_LABEL[x.status],
        x.fixRef ? `${x.fixRef}\n${x.fixedBy ?? ''} ${fmtDate(x.fixedAt)}` : '',
        x.retestResult ? `${STATUS_LABEL[x.retestResult]}\n${x.retestedBy ?? ''} ${fmtDate(x.retestedAt)}` : '',
      ]),
    );
  }

  // Sign-off
  h2('Sign-off');
  if (report.signOffs.length === 0) {
    doc.fillColor(GREY).font('Helvetica').fontSize(10).text('Not signed off yet. This is a draft report.', left);
    doc.moveDown(0.8);
    table(
      [{ h: 'Role', w: 140 }, { h: 'Name', w: 160 }, { h: 'Signature', w: W - 140 - 160 - 90 }, { h: 'Date', w: 90 }],
      ['Prepared by', 'Tested by', 'Reviewed by', 'Approved by'].map((r) => [r, '', '\n\n', '']),
    );
  } else {
    table(
      [{ h: 'Name', w: 160 }, { h: 'Role', w: 140 }, { h: 'Company', w: W - 160 - 140 - 110 }, { h: 'Signed', w: 110 }],
      report.signOffs.map((x) => [x.name, x.role, x.company ?? '', fmtDateTime(x.signedAt)]),
    );
    doc.fillColor(GREY).font('Helvetica').fontSize(9).text(
      `This run was locked at sign-off. No edits are possible after this point. All changes before sign-off are kept in the audit log. Report ID ${report.reportId}${report.reportHash ? `, hash ${report.reportHash}` : ''}.`,
      left,
      doc.y,
      { width: W },
    );
  }

  // Header and footer on every page after the cover
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    if (i > range.start) {
      doc.rect(0, 0, doc.page.width, 6).fill(navy);
      doc.fillColor(navy).font('Helvetica-Bold').fontSize(8.5).text(report.brand.company, left, 24, { width: W / 2, lineBreak: false });
      doc.fillColor(GREY).font('Helvetica').fontSize(8.5).text(`UAT Report for ${client}  |  ${report.reportId}`, left + W / 2, 24, { width: W / 2, align: 'right', lineBreak: false });
    }
    doc.fillColor(GREY).font('Helvetica').fontSize(8).text(`Page ${i - range.start + 1} of ${range.count}`, left, doc.page.height - 36, { width: W, align: 'right', lineBreak: false });
    doc.fillColor(GREY).text(report.locked ? 'Signed off. Read only.' : 'Draft', left, doc.page.height - 36, { width: W / 2, lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}
