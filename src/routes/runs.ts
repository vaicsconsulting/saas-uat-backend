import { Router, type Request } from 'express';
import express from 'express';
import path from 'node:path';
import { config } from '../config';
import { prisma } from '../db';
import { ah, badRequest, notFound } from '../lib/errors';
import { randomToken, sha256 } from '../lib/crypto';
import { requireAuth, requireRole, ROLES } from '../auth/jwt';
import { DefectPatch, FixBody, PresignBody, ResultBody, RunPatch, ShareLinkBody, SignOffBody } from '../schemas';
import { audit } from '../services/audit';
import { subscribe } from '../services/bus';
import { assertUnlocked, getRunOr404, markFixed, recordResult, runCounts, updateDefect } from '../services/runs';
import { attachmentDto, defectDto, defectInclude, runCaseDto, runCaseInclude, runDto } from '../services/serialize';
import { runStats } from '../services/stats';
import { buildReport, signOff } from '../services/report';
import { renderPdf } from '../services/pdf';
import { exportRun, importResults } from '../services/excel';
import { importDocx } from '../services/docx';
import { storage } from '../storage';
import { upload } from './projects';

export const runsRouter = Router();

const p = (req: Request, k: string) => String(req.params[k]);

async function fullRunDto(id: string) {
  const r = await getRunOr404(prisma, id);
  return runDto(r, (await runCounts([id])).get(id)!);
}

async function caseOut(id: string) {
  const c = await prisma.runCase.findUnique({ where: { id }, include: runCaseInclude });
  if (!c) throw notFound('Case not found');
  return runCaseDto(c);
}

async function defectOut(id: string) {
  const x = await prisma.defect.findUnique({ where: { id }, include: defectInclude });
  if (!x) throw notFound('Defect not found');
  const atts = await prisma.attachment.findMany({ where: { defectId: id, confirmed: true }, orderBy: { createdAt: 'asc' } });
  return defectDto(x, atts);
}

// Runs
runsRouter.get('/runs/:id', requireAuth, ah(async (req, res) => res.json(await fullRunDto(p(req, 'id')))));

runsRouter.patch(
  '/runs/:id',
  requireAuth,
  requireRole(...ROLES.admin),
  ah(async (req, res) => {
    const body = RunPatch.parse(req.body);
    const id = p(req, 'id');
    await prisma.$transaction(async (tx) => {
      const run = await assertUnlocked(tx, id);
      await tx.run.update({ where: { id }, data: body });
      await audit(tx, req.user, { runId: id, projectId: run.projectId, action: 'run.updated', entity: 'run', entityId: id, data: body });
    });
    res.json(await fullRunDto(id));
  }),
);

runsRouter.get(
  '/runs/:id/cases',
  requireAuth,
  ah(async (req, res) => {
    const cases = await prisma.runCase.findMany({ where: { runId: p(req, 'id') }, orderBy: { sortOrder: 'asc' }, include: runCaseInclude });
    res.json(await Promise.all(cases.map(runCaseDto)));
  }),
);

runsRouter.get('/runs/:id/stats', requireAuth, ah(async (req, res) => res.json(await runStats(p(req, 'id')))));

runsRouter.get(
  '/runs/:id/events',
  requireAuth,
  ah(async (req, res) => {
    const id = p(req, 'id');
    await getRunOr404(prisma, id);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: ready\ndata: {"runId":"${id}"}\n\n`);
    const off = subscribe(id, (s) => res.write(`event: change\ndata: ${JSON.stringify(s)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      off();
    });
  }),
);

runsRouter.get(
  '/runs/:id/defects',
  requireAuth,
  ah(async (req, res) => {
    const list = await prisma.defect.findMany({ where: { runId: p(req, 'id') }, orderBy: { number: 'asc' }, select: { id: true } });
    res.json(await Promise.all(list.map((x) => defectOut(x.id))));
  }),
);

runsRouter.post(
  '/runs/:id/import-results',
  requireAuth,
  requireRole(...ROLES.testers),
  upload.single('file'),
  ah(async (req, res) => {
    if (!req.file) throw badRequest('Attach an .xlsx file in the "file" field');
    res.json(await importResults(req.user!, p(req, 'id'), req.file.buffer));
  }),
);

runsRouter.post(
  '/runs/:id/import-docx',
  requireAuth,
  requireRole(...ROLES.testers),
  upload.single('file'),
  ah(async (req, res) => {
    if (!req.file) throw badRequest('Attach a .docx file in the "file" field');
    res.json(await importDocx(req.user!, p(req, 'id'), req.file.buffer));
  }),
);

const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);

runsRouter.get(
  '/runs/:id/export',
  requireAuth,
  ah(async (req, res) => {
    const run = await getRunOr404(prisma, p(req, 'id'));
    const buf = await exportRun(run.id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileSafe(`${run.project.name}_Test_Tracker_${run.name}`)}.xlsx"`);
    res.send(buf);
  }),
);

runsRouter.get('/runs/:id/report', requireAuth, ah(async (req, res) => res.json(await buildReport(p(req, 'id')))));

runsRouter.get(
  '/runs/:id/report.pdf',
  requireAuth,
  ah(async (req, res) => {
    const report = await buildReport(p(req, 'id'));
    const pdf = await renderPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${report.reportId}.pdf"`);
    res.send(pdf);
  }),
);

runsRouter.get(
  '/runs/:id/audit-log',
  requireAuth,
  ah(async (req, res) => {
    const rows = await prisma.auditLog.findMany({ where: { runId: p(req, 'id') }, orderBy: { createdAt: 'asc' } });
    res.json(rows.map((r) => ({ id: r.id, action: r.action, entity: r.entity, entityId: r.entityId, actorName: r.actorName, data: r.data, createdAt: r.createdAt.toISOString() })));
  }),
);

runsRouter.post(
  '/runs/:id/signoff',
  requireAuth,
  requireRole(...ROLES.admin),
  ah(async (req, res) => {
    const body = SignOffBody.parse(req.body);
    await signOff(req.user!, p(req, 'id'), body.signers);
    res.json(await fullRunDto(p(req, 'id')));
  }),
);

const linkDto = (l: { id: string; label: string; tokenHint: string; expiresAt: Date; revokedAt: Date | null; lastUsedAt: Date | null; createdAt: Date }, url?: string) => ({
  id: l.id,
  label: l.label,
  tokenHint: l.tokenHint,
  expiresAt: l.expiresAt.toISOString(),
  revokedAt: l.revokedAt?.toISOString() ?? null,
  lastUsedAt: l.lastUsedAt?.toISOString() ?? null,
  createdAt: l.createdAt.toISOString(),
  ...(url ? { url } : {}),
});

runsRouter.get(
  '/runs/:id/share-links',
  requireAuth,
  requireRole(...ROLES.admin),
  ah(async (req, res) => {
    const rows = await prisma.shareLink.findMany({ where: { runId: p(req, 'id') }, orderBy: { createdAt: 'desc' } });
    res.json(rows.map((r) => linkDto(r)));
  }),
);

runsRouter.post(
  '/runs/:id/share-links',
  requireAuth,
  requireRole(...ROLES.admin),
  ah(async (req, res) => {
    const body = ShareLinkBody.parse(req.body);
    const id = p(req, 'id');
    const run = await getRunOr404(prisma, id);
    const token = randomToken(32);
    const link = await prisma.$transaction(async (tx) => {
      const l = await tx.shareLink.create({
        data: { runId: id, label: body.label, tokenHash: sha256(token), tokenHint: token.slice(-4), expiresAt: new Date(Date.now() + body.expiresInDays * 86400_000), createdById: req.user!.id },
      });
      await audit(tx, req.user, { runId: id, projectId: run.projectId, action: 'share_link.created', entity: 'share_link', entityId: l.id, data: { label: body.label, expiresAt: l.expiresAt.toISOString() } });
      return l;
    });
    res.status(201).json(linkDto(link, `${config.appUrl}/audit/${token}`));
  }),
);

runsRouter.delete(
  '/share-links/:id',
  requireAuth,
  requireRole(...ROLES.admin),
  ah(async (req, res) => {
    const id = p(req, 'id');
    await prisma.$transaction(async (tx) => {
      const l = await tx.shareLink.update({ where: { id }, data: { revokedAt: new Date() } });
      await audit(tx, req.user, { runId: l.runId, action: 'share_link.revoked', entity: 'share_link', entityId: id, data: { label: l.label } });
    });
    res.status(204).end();
  }),
);

// Cases
runsRouter.get('/cases/:id', requireAuth, ah(async (req, res) => res.json(await caseOut(p(req, 'id')))));

runsRouter.get(
  '/cases/:id/history',
  requireAuth,
  ah(async (req, res) => {
    const id = p(req, 'id');
    const [events, atts] = await Promise.all([
      prisma.caseEvent.findMany({ where: { runCaseId: id }, orderBy: { createdAt: 'asc' } }),
      prisma.attachment.findMany({ where: { runCaseId: id, confirmed: true } }),
    ]);
    res.json(
      await Promise.all(
        events.map(async (e) => {
          const linked = atts.filter((a) => a.eventId === e.id || (e.kind === 'screenshot' && (e.data as { attachmentId?: string } | null)?.attachmentId === a.id));
          return {
            id: e.id,
            kind: e.kind,
            status: e.status,
            note: e.note,
            actorName: e.actorName,
            data: (e.data as Record<string, unknown> | null) ?? null,
            attachments: await Promise.all(linked.map(attachmentDto)),
            createdAt: e.createdAt.toISOString(),
          };
        }),
      ),
    );
  }),
);

runsRouter.post(
  '/cases/:id/result',
  requireAuth,
  requireRole(...ROLES.testers),
  ah(async (req, res) => {
    const body = ResultBody.parse(req.body);
    const id = p(req, 'id');
    const out = await recordResult(req.user!, id, body);
    res.json({ case: await caseOut(id), defect: out.defectId ? await defectOut(out.defectId) : null, retest: out.retest });
  }),
);

const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

runsRouter.post(
  '/cases/:id/attachments',
  requireAuth,
  requireRole(...ROLES.testers),
  ah(async (req, res) => {
    const body = PresignBody.parse(req.body);
    if (body.size > config.maxUploadMb * 1024 * 1024) throw badRequest(`Max ${config.maxUploadMb} MB per screenshot`);
    const rc = await prisma.runCase.findUnique({ where: { id: p(req, 'id') } });
    if (!rc) throw notFound('Case not found');
    await assertUnlocked(prisma, rc.runId);
    const key = `runs/${rc.runId}/${rc.id}/${randomToken(9)}${EXT[body.mimeType]}`;
    const a = await prisma.attachment.create({
      data: { runCaseId: rc.id, storageKey: key, fileName: path.basename(body.fileName).slice(0, 200), mimeType: body.mimeType, size: body.size, uploadedById: req.user!.id },
    });
    res.status(201).json({ attachmentId: a.id, upload: await storage().presignUpload(key, body.mimeType) });
  }),
);

runsRouter.post(
  '/attachments/:id/confirm',
  requireAuth,
  requireRole(...ROLES.testers),
  ah(async (req, res) => {
    const a = await prisma.attachment.findUnique({ where: { id: p(req, 'id') }, include: { runCase: { select: { runId: true } } } });
    if (!a) throw notFound('Screenshot not found');
    await assertUnlocked(prisma, a.runCase.runId);
    const size = await storage().size(a.storageKey);
    if (size === null) throw badRequest('Upload the file first');
    const done = await prisma.attachment.update({ where: { id: a.id }, data: { confirmed: true, size } });
    await prisma.auditLog.create({
      data: { runId: a.runCase.runId, actorId: req.user!.id, actorName: req.user!.name, action: 'screenshot.added', entity: 'attachment', entityId: a.id, data: { runCaseId: a.runCaseId, fileName: a.fileName } },
    });
    res.json(await attachmentDto(done));
  }),
);

// Defects
runsRouter.get('/defects/:id', requireAuth, ah(async (req, res) => res.json(await defectOut(p(req, 'id')))));

runsRouter.patch(
  '/defects/:id',
  requireAuth,
  requireRole(...ROLES.workers),
  ah(async (req, res) => {
    const body = DefectPatch.parse(req.body);
    await updateDefect(req.user!, p(req, 'id'), body);
    res.json(await defectOut(p(req, 'id')));
  }),
);

runsRouter.post(
  '/defects/:id/fix',
  requireAuth,
  requireRole(...ROLES.devs),
  ah(async (req, res) => {
    const body = FixBody.parse(req.body);
    await markFixed(req.user!, p(req, 'id'), body);
    res.json(await defectOut(p(req, 'id')));
  }),
);

// Local storage endpoints (dev). Signed with HMAC, short expiry.
export const filesRouter = Router();
filesRouter.put(
  '/files/upload',
  express.raw({ type: () => true, limit: `${config.maxUploadMb}mb` }),
  ah(async (req, res) => {
    const { verifyLocal } = await import('../storage');
    const key = String(req.query.key ?? '');
    if (!verifyLocal('up', key, Number(req.query.exp), String(req.query.sig ?? ''))) throw badRequest('Upload link is not valid');
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest('Empty file');
    await storage().put(key, req.body, String(req.headers['content-type'] ?? 'application/octet-stream'));
    res.status(200).json({ ok: true });
  }),
);
filesRouter.get(
  '/files/view',
  ah(async (req, res) => {
    const { verifyLocal } = await import('../storage');
    const key = String(req.query.key ?? '');
    if (!verifyLocal('view', key, Number(req.query.exp), String(req.query.sig ?? ''))) throw notFound();
    const a = await prisma.attachment.findUnique({ where: { storageKey: key } });
    const buf = await storage().get(key).catch(() => null);
    if (!buf) throw notFound();
    res.setHeader('Content-Type', a?.mimeType ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(buf);
  }),
);
