import type { CaseStatus, Prisma } from '@prisma/client';
import { prisma, type Tx } from '../db';
import { conflict, locked, notFound, badRequest } from '../lib/errors';
import type { AuthUser } from '../types';
import { audit } from './audit';
import { publish } from './bus';
import { randomToken } from '../lib/crypto';

export function newReportId(key: string, at = new Date()): string {
  const ymd = at.toISOString().slice(0, 10).replace(/-/g, '');
  const tail = randomToken(6).replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase().padEnd(4, 'X');
  return `UAT-${key}-${ymd}-${tail}`;
}

export async function getRunOr404(tx: Tx, runId: string) {
  const run = await tx.run.findUnique({ where: { id: runId }, include: { project: { select: { key: true, name: true } } } });
  if (!run) throw notFound('Run not found');
  return run;
}

export async function assertUnlocked(tx: Tx, runId: string) {
  const run = await getRunOr404(tx, runId);
  if (run.lockedAt) throw locked();
  return run;
}

export async function runCounts(runIds: string[]) {
  const rows = await prisma.runCase.groupBy({
    by: ['runId', 'status'],
    where: { runId: { in: runIds } },
    _count: { _all: true },
  });
  const out = new Map<string, { total: number; done: number }>();
  for (const id of runIds) out.set(id, { total: 0, done: 0 });
  for (const r of rows) {
    const c = out.get(r.runId)!;
    c.total += r._count._all;
    if (r.status !== 'NOT_RUN') c.done += r._count._all;
  }
  return out;
}

/** Creates a run and snapshots the project's template cases into it. */
export async function createRun(
  user: AuthUser,
  projectId: string,
  body: { name: string; environment: string; buildTag?: string | null; baseUrl?: string | null; clientName?: string | null; clientLogoUrl?: string | null },
) {
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.findUnique({ where: { id: projectId } });
    if (!project) throw notFound('Project not found');
    const cases = await tx.templateCase.findMany({ where: { projectId }, orderBy: [{ sortOrder: 'asc' }, { caseKey: 'asc' }] });
    if (cases.length === 0) throw badRequest('Add or import test cases before starting a run');
    const run = await tx.run.create({
      data: {
        projectId,
        name: body.name,
        environment: body.environment,
        buildTag: body.buildTag ?? null,
        baseUrl: body.baseUrl ?? project.devBaseUrl,
        clientName: body.clientName ?? project.clientName,
        clientLogoUrl: body.clientLogoUrl ?? project.clientLogoUrl,
        reportId: newReportId(project.key),
      },
    });
    await tx.runCase.createMany({
      data: cases.map((c, i) => ({
        runId: run.id,
        caseKey: c.caseKey,
        module: c.module,
        title: c.title,
        role: c.role,
        path: c.path,
        priority: c.priority,
        type: c.type,
        preconditions: c.preconditions,
        steps: c.steps,
        expected: c.expected,
        testData: c.testData,
        sortOrder: i,
      })),
    });
    await audit(tx, user, { runId: run.id, projectId, action: 'run.created', entity: 'run', entityId: run.id, data: { name: run.name, cases: cases.length } });
    return run;
  });
}

export interface ResultInput {
  status: Exclude<CaseStatus, 'NOT_RUN'>;
  actualResult?: string | null;
  version: number;
  attachmentIds: string[];
}

/**
 * Records a tester result. Uses the case version for optimistic concurrency.
 * Fail opens a defect. When the case is waiting for a retest, the result is a
 * retest and updates the fixed defect instead.
 */
export async function recordResult(user: AuthUser, runCaseId: string, input: ResultInput) {
  const out = await prisma.$transaction(async (tx) => {
    const rc = await tx.runCase.findUnique({ where: { id: runCaseId } });
    if (!rc) throw notFound('Case not found');
    const run = await assertUnlocked(tx, rc.runId);
    const now = new Date();
    const upd = await tx.runCase.updateMany({
      where: { id: rc.id, version: input.version },
      data: {
        status: input.status,
        actualResult: input.actualResult ?? null,
        testedById: user.id,
        testedByName: user.name,
        testedAt: now,
        needsRetest: false,
        version: { increment: 1 },
      },
    });
    if (upd.count === 0) {
      const current = await tx.runCase.findUnique({ where: { id: rc.id }, include: { testedBy: { select: { name: true } } } });
      throw conflict('Someone else updated this case. Check the latest result and try again', {
        version: current?.version,
        status: current?.status,
        testedBy: current?.testedBy?.name ?? null,
      });
    }

    const fixed = await tx.defect.findFirst({ where: { runCaseId: rc.id, status: 'FIXED' }, orderBy: { createdAt: 'desc' } });
    const isRetest = Boolean(rc.needsRetest || fixed);
    const event = await tx.caseEvent.create({
      data: {
        runCaseId: rc.id,
        kind: isRetest ? 'retest' : 'result',
        status: input.status,
        note: input.actualResult ?? null,
        actorId: user.id,
        actorName: user.name,
        data: fixed ? { defectId: fixed.id, defectCode: fixed.code } : undefined,
      },
    });

    let attachIds: string[] = [];
    if (input.attachmentIds.length) {
      const atts = await tx.attachment.findMany({ where: { id: { in: input.attachmentIds }, runCaseId: rc.id, confirmed: true } });
      attachIds = atts.map((a) => a.id);
      await tx.attachment.updateMany({ where: { id: { in: attachIds } }, data: { eventId: event.id } });
    }

    let defectId: string | null = null;
    if (fixed) {
      const passed = input.status === 'PASS';
      await tx.defect.update({
        where: { id: fixed.id },
        data: {
          status: passed ? 'RETEST_PASSED' : 'RETEST_FAILED',
          retestResult: input.status,
          retestedBy: user.name,
          retestedAt: now,
          version: { increment: 1 },
        },
      });
      defectId = fixed.id;
      if (attachIds.length && !passed) await tx.attachment.updateMany({ where: { id: { in: attachIds } }, data: { defectId: fixed.id } });
    } else if (input.status === 'FAIL') {
      const existing = await tx.defect.findFirst({
        where: { runCaseId: rc.id, status: { in: ['OPEN', 'RETEST_FAILED'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        defectId = existing.id;
        if (attachIds.length) await tx.attachment.updateMany({ where: { id: { in: attachIds } }, data: { defectId: existing.id } });
      } else {
        const p = await tx.project.update({ where: { id: run.projectId }, data: { defectSeq: { increment: 1 } } });
        const code = `DEF-${String(p.defectSeq).padStart(3, '0')}`;
        const defect = await tx.defect.create({
          data: {
            projectId: run.projectId,
            runId: run.id,
            runCaseId: rc.id,
            code,
            number: p.defectSeq,
            title: `${rc.caseKey}: ${rc.title}`.slice(0, 1000),
            note: input.actualResult ?? null,
            severity: rc.priority,
            reportedById: user.id,
          },
        });
        defectId = defect.id;
        if (attachIds.length) await tx.attachment.updateMany({ where: { id: { in: attachIds } }, data: { defectId: defect.id } });
        await tx.caseEvent.create({
          data: { runCaseId: rc.id, kind: 'defect_opened', note: code, actorId: user.id, actorName: user.name, data: { defectId: defect.id, defectCode: code } },
        });
        await audit(tx, user, { runId: run.id, projectId: run.projectId, action: 'defect.opened', entity: 'defect', entityId: defect.id, data: { code, caseKey: rc.caseKey } });
      }
    }

    await audit(tx, user, {
      runId: run.id,
      projectId: run.projectId,
      action: isRetest ? 'case.retested' : 'case.result',
      entity: 'run_case',
      entityId: rc.id,
      data: { caseKey: rc.caseKey, from: rc.status, to: input.status, note: input.actualResult ?? null, attachments: attachIds } as Prisma.InputJsonValue,
    });
    return { runId: run.id, defectId, retest: isRetest };
  });
  publish(out.runId, 'case', runCaseId);
  if (out.defectId) publish(out.runId, 'defect', out.defectId);
  return out;
}

export async function markFixed(user: AuthUser, defectId: string, input: { version: number; fixRef: string; note?: string | null }) {
  const out = await prisma.$transaction(async (tx) => {
    const x = await tx.defect.findUnique({ where: { id: defectId } });
    if (!x) throw notFound('Defect not found');
    await assertUnlocked(tx, x.runId);
    if (!['OPEN', 'RETEST_FAILED'].includes(x.status)) throw badRequest('Only open or retest failed defects can be marked fixed');
    const now = new Date();
    const upd = await tx.defect.updateMany({
      where: { id: x.id, version: input.version },
      data: { status: 'FIXED', fixRef: input.fixRef, fixedByName: user.name, fixedAt: now, retestResult: null, retestedAt: null, retestedBy: null, version: { increment: 1 } },
    });
    if (upd.count === 0) throw conflict('Someone else updated this defect. Reload and try again');
    await tx.runCase.update({ where: { id: x.runCaseId }, data: { needsRetest: true, version: { increment: 1 } } });
    await tx.caseEvent.create({
      data: {
        runCaseId: x.runCaseId,
        kind: 'fixed',
        note: input.note ?? null,
        actorId: user.id,
        actorName: user.name,
        data: { defectId: x.id, defectCode: x.code, fixRef: input.fixRef },
      },
    });
    await audit(tx, user, { runId: x.runId, projectId: x.projectId, action: 'defect.fixed', entity: 'defect', entityId: x.id, data: { code: x.code, fixRef: input.fixRef } });
    return x;
  });
  publish(out.runId, 'defect', out.id);
  publish(out.runId, 'case', out.runCaseId);
}

export async function updateDefect(
  user: AuthUser,
  defectId: string,
  input: { version: number; assigneeId?: string | null; severity?: string; title?: string; note?: string | null; status?: 'OPEN' | 'CLOSED' },
) {
  const out = await prisma.$transaction(async (tx) => {
    const x = await tx.defect.findUnique({ where: { id: defectId } });
    if (!x) throw notFound('Defect not found');
    await assertUnlocked(tx, x.runId);
    if (input.assigneeId) {
      const u = await tx.user.findUnique({ where: { id: input.assigneeId } });
      if (!u || !u.active) throw badRequest('Assignee not found');
    }
    const data: Prisma.DefectUpdateManyMutationInput & { assigneeId?: string | null } = { version: { increment: 1 } };
    if (input.assigneeId !== undefined) data.assigneeId = input.assigneeId;
    if (input.severity !== undefined) data.severity = input.severity;
    if (input.title !== undefined) data.title = input.title;
    if (input.note !== undefined) data.note = input.note;
    if (input.status !== undefined) data.status = input.status;
    const upd = await tx.defect.updateMany({ where: { id: x.id, version: input.version }, data });
    if (upd.count === 0) throw conflict('Someone else updated this defect. Reload and try again');
    if (input.status && input.status !== x.status) {
      await tx.caseEvent.create({
        data: {
          runCaseId: x.runCaseId,
          kind: input.status === 'CLOSED' ? 'defect_closed' : 'defect_reopened',
          actorId: user.id,
          actorName: user.name,
          data: { defectId: x.id, defectCode: x.code },
        },
      });
      if (input.status === 'CLOSED') await tx.runCase.update({ where: { id: x.runCaseId }, data: { needsRetest: false, version: { increment: 1 } } });
    }
    await audit(tx, user, { runId: x.runId, projectId: x.projectId, action: 'defect.updated', entity: 'defect', entityId: x.id, data: { code: x.code, ...input } as Prisma.InputJsonValue });
    return x;
  });
  publish(out.runId, 'defect', out.id);
}
