import type { Prisma } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
import { badRequest, notFound } from '../lib/errors';
import { canonicalJson, sha256 } from '../lib/crypto';
import type { AuthUser } from '../types';
import { audit } from './audit';
import { publish } from './bus';
import { assertUnlocked, newReportId } from './runs';
import { attachmentDto, defectDto, defectInclude } from './serialize';
import { runStats } from './stats';

async function loadRun(runId: string) {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      project: { select: { key: true, name: true } },
      cases: {
        orderBy: { sortOrder: 'asc' },
        include: {
          testedBy: { select: { name: true } },
          attachments: { where: { confirmed: true }, orderBy: { createdAt: 'asc' } },
          defects: { select: { code: true } },
        },
      },
      defects: { orderBy: { number: 'asc' }, include: defectInclude },
      signOffs: { orderBy: { signedAt: 'asc' } },
    },
  });
  if (!run) throw notFound('Run not found');
  return run;
}

/** Content that the report hash covers. Excludes signed URLs, which change. */
function hashSource(run: Awaited<ReturnType<typeof loadRun>>) {
  return {
    reportId: run.reportId,
    project: run.project.key,
    run: { name: run.name, environment: run.environment, buildTag: run.buildTag, baseUrl: run.baseUrl, startedAt: run.startedAt },
    cases: run.cases.map((c) => ({
      k: c.caseKey,
      s: c.status,
      a: c.actualResult,
      t: c.testedByName ?? null,
      at: c.testedAt,
      img: c.attachments.map((a) => a.storageKey),
    })),
    defects: run.defects.map((x) => ({ c: x.code, s: x.status, f: x.fixRef, r: x.retestResult, ra: x.retestedAt })),
    signOffs: run.signOffs.map((s) => ({ n: s.name, r: s.role, c: s.company, at: s.signedAt })),
  };
}

export async function buildReport(runId: string) {
  const run = await loadRun(runId);
  const stats = await runStats(runId);
  const defAtts = await prisma.attachment.findMany({ where: { defectId: { in: run.defects.map((x) => x.id) }, confirmed: true } });
  const tested = run.cases.map((c) => c.testedAt).filter((x): x is Date => Boolean(x));
  const windowEnd = run.endedAt ?? (tested.length ? new Date(Math.max(...tested.map((x) => x.getTime()))) : null);
  const testers = [...new Set(run.cases.map((c) => c.testedByName).filter((x): x is string => Boolean(x)))];
  return {
    reportId: run.reportId ?? newReportId(run.project.key, run.createdAt),
    reportHash: run.reportHash,
    locked: Boolean(run.lockedAt),
    generatedAt: new Date().toISOString(),
    brand: { company: config.brand.company, primary: config.brand.primary },
    client: { name: run.clientName, logoUrl: run.clientLogoUrl },
    project: { key: run.project.key, name: run.project.name },
    run: {
      name: run.name,
      environment: run.environment,
      buildTag: run.buildTag,
      baseUrl: run.baseUrl,
      windowStart: (tested.length ? new Date(Math.min(...tested.map((x) => x.getTime()))) : run.startedAt).toISOString(),
      windowEnd: windowEnd ? windowEnd.toISOString() : null,
    },
    stats,
    cases: await Promise.all(
      run.cases.map(async (c) => ({
        caseKey: c.caseKey,
        module: c.module,
        title: c.title,
        priority: c.priority,
        type: c.type,
        expected: c.expected,
        status: c.status,
        actualResult: c.actualResult,
        testedBy: c.testedByName ?? null,
        testedAt: c.testedAt ? c.testedAt.toISOString() : null,
        defectCodes: c.defects.map((x) => x.code),
        screenshots: await Promise.all(c.attachments.map(attachmentDto)),
      })),
    ),
    defects: await Promise.all(run.defects.map((x) => defectDto(x, defAtts.filter((a) => a.defectId === x.id)))),
    signOffs: run.signOffs.map((s) => ({ id: s.id, name: s.name, role: s.role, company: s.company, signedAt: s.signedAt.toISOString() })),
    testers,
  };
}
export type AuditReportData = Awaited<ReturnType<typeof buildReport>>;

export async function computeHash(runId: string): Promise<string> {
  return sha256(canonicalJson(hashSource(await loadRun(runId))));
}

/** Records signers, locks the run and stores the report hash. */
export async function signOff(user: AuthUser, runId: string, signers: { name: string; role: string; company?: string | null }[]) {
  await prisma.$transaction(async (tx) => {
    const run = await assertUnlocked(tx, runId);
    const notRun = await tx.runCase.count({ where: { runId, status: 'NOT_RUN' } });
    const retest = await tx.runCase.count({ where: { runId, needsRetest: true } });
    if (notRun > 0) throw badRequest(`${notRun} case(s) are not run yet. Mark them Blocked or run them first`);
    if (retest > 0) throw badRequest(`${retest} case(s) still wait for a retest`);
    const now = new Date();
    await tx.signOff.createMany({ data: signers.map((s) => ({ runId, name: s.name, role: s.role, company: s.company ?? null, signedAt: now, userId: user.id })) });
    await tx.run.update({
      where: { id: runId },
      data: { status: 'SIGNED_OFF', lockedAt: now, endedAt: run.endedAt ?? now, reportId: run.reportId ?? newReportId(run.project.key, run.createdAt) },
    });
    await audit(tx, user, { runId, projectId: run.projectId, action: 'run.signed_off', entity: 'run', entityId: runId, data: { signers } as Prisma.InputJsonValue });
  });
  const hash = await computeHash(runId);
  await prisma.run.update({ where: { id: runId }, data: { reportHash: hash } });
  await prisma.auditLog.create({ data: { runId, actorId: user.id, actorName: user.name, action: 'run.locked', entity: 'run', entityId: runId, data: { reportHash: hash } } });
  publish(runId, 'run', runId);
  return hash;
}
