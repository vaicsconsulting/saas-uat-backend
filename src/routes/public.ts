import { Router } from 'express';
import { prisma } from '../db';
import { ah, notFound } from '../lib/errors';
import { sha256 } from '../lib/crypto';
import { buildReport } from '../services/report';
import { renderPdf } from '../services/pdf';

export const publicRouter = Router();

/** Resolves a client share token. Expired or revoked links return 404. */
async function resolve(token: string) {
  const link = await prisma.shareLink.findUnique({ where: { tokenHash: sha256(token) } });
  if (!link || link.revokedAt || link.expiresAt < new Date()) throw notFound('This link is not valid or has expired');
  await prisma.shareLink.update({ where: { id: link.id }, data: { lastUsedAt: new Date() } });
  return link;
}

publicRouter.get(
  '/public/audit/:token',
  ah(async (req, res) => {
    const link = await resolve(String(req.params.token));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.json({ ...(await buildReport(link.runId)), shareExpiresAt: link.expiresAt.toISOString() });
  }),
);

publicRouter.get(
  '/public/audit/:token/pdf',
  ah(async (req, res) => {
    const link = await resolve(String(req.params.token));
    const report = await buildReport(link.runId);
    const pdf = await renderPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${report.reportId}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  }),
);
