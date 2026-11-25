import path from 'node:path';
import JSZip from 'jszip';
import { prisma } from '../db';
import { badRequest } from '../lib/errors';
import { randomToken } from '../lib/crypto';
import { storage } from '../storage';
import type { AuthUser } from '../types';
import { audit } from './audit';
import { publish } from './bus';
import { assertUnlocked } from './runs';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

export interface DocxImage {
  caseKey: string | null;
  target: string;
}

/**
 * Walks the document in order. Each image is matched to the nearest case ID
 * written before it (for example "VV-001"). Images before any ID get the next ID.
 */
export function matchImages(documentXml: string, rels: Map<string, string>, keyPattern: RegExp): DocxImage[] {
  const token = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|r:embed="([^"]+)"|<\/w:p>/g;
  const out: DocxImage[] = [];
  const pending: DocxImage[] = [];
  let para = '';
  let current: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = token.exec(documentXml))) {
    if (m[1] !== undefined) {
      para += m[1];
      const ids = para.match(keyPattern);
      if (ids) {
        current = ids[ids.length - 1].toUpperCase();
        for (const p of pending.splice(0)) p.caseKey = current;
      }
    } else if (m[2]) {
      const target = rels.get(m[2]);
      if (!target) continue;
      const img = { caseKey: current, target };
      if (!current) pending.push(img);
      out.push(img);
    } else {
      para = '';
    }
  }
  return out;
}

export async function importDocx(user: AuthUser, runId: string, buf: Buffer) {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw badRequest('Could not read that file. Upload a .docx');
  }
  const docXml = await zip.file('word/document.xml')?.async('string');
  const relXml = await zip.file('word/_rels/document.xml.rels')?.async('string');
  if (!docXml || !relXml) throw badRequest('That .docx has no document body');
  const rels = new Map<string, string>();
  for (const r of relXml.matchAll(/<Relationship\s[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"[^>]*?\/>/g)) rels.set(r[1], r[2]);
  for (const r of relXml.matchAll(/<Relationship\s[^>]*?Target="([^"]+)"[^>]*?Id="([^"]+)"[^>]*?\/>/g)) rels.set(r[2], r[1]);

  const run = await prisma.$transaction((tx) => assertUnlocked(tx, runId));
  const cases = await prisma.runCase.findMany({ where: { runId }, select: { id: true, caseKey: true } });
  const byKey = new Map(cases.map((c) => [c.caseKey.toUpperCase(), c.id]));
  const prefix = run.project.key.replace(/[^A-Z0-9]/gi, '');
  const pattern = new RegExp(`\\b(?:${prefix}|[A-Z]{2,6})-\\d{2,4}\\b`, 'gi');
  const images = matchImages(docXml, rels, pattern);

  let created = 0;
  let skipped = 0;
  const warnings: string[] = [];
  for (const img of images) {
    const rcId = img.caseKey ? byKey.get(img.caseKey) : undefined;
    if (!rcId) {
      skipped++;
      if (img.caseKey) warnings.push(`Image ${path.basename(img.target)} matched ${img.caseKey}, which is not in this run`);
      else warnings.push(`Image ${path.basename(img.target)} has no case ID near it`);
      continue;
    }
    const file = zip.file(`word/${img.target.replace(/^\/?word\//, '').replace(/^\.\//, '')}`);
    const mime = MIME[path.extname(img.target).toLowerCase()];
    if (!file || !mime) {
      skipped++;
      continue;
    }
    const body = await file.async('nodebuffer');
    const key = `runs/${runId}/${rcId}/${randomToken(9)}${path.extname(img.target).toLowerCase()}`;
    await storage().put(key, body, mime);
    await prisma.$transaction(async (tx) => {
      const a = await tx.attachment.create({
        data: { runCaseId: rcId, storageKey: key, fileName: path.basename(img.target), mimeType: mime, size: body.length, confirmed: true, uploadedById: user.id },
      });
      await tx.caseEvent.create({
        data: { runCaseId: rcId, kind: 'screenshot', note: 'Screenshot imported from Word file', actorId: user.id, actorName: user.name, data: { attachmentId: a.id, source: 'docx' } },
      });
    });
    created++;
  }
  await prisma.auditLog.create({
    data: { runId, projectId: run.projectId, actorId: user.id, actorName: user.name, action: 'screenshots.imported', entity: 'run', entityId: runId, data: { created, skipped } },
  });
  publish(runId, 'run', runId);
  return { created, updated: 0, skipped, warnings: warnings.slice(0, 50) };
}

