import { prisma } from '../db';

export async function runStats(runId: string) {
  const [cases, defects, recent] = await Promise.all([
    prisma.runCase.findMany({
      where: { runId },
      select: { module: true, status: true, needsRetest: true, sortOrder: true, updatedAt: true, testedByName: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.defect.groupBy({ by: ['status'], where: { runId }, _count: { _all: true } }),
    prisma.caseEvent.findMany({
      where: { runCase: { runId } },
      orderBy: { createdAt: 'desc' },
      take: 12,
      include: { runCase: { select: { caseKey: true } } },
    }),
  ]);
  const zero = () => ({ total: 0, pass: 0, fail: 0, blocked: 0, notRun: 0 });
  const tot = zero();
  const modules = new Map<string, ReturnType<typeof zero>>();
  const testers = new Map<string, { count: number; pass: number; fail: number; blocked: number }>();
  let needsRetest = 0;
  let last = new Date(0);
  for (const c of cases) {
    if (!modules.has(c.module)) modules.set(c.module, zero());
    const m = modules.get(c.module)!;
    const k = c.status === 'PASS' ? 'pass' : c.status === 'FAIL' ? 'fail' : c.status === 'BLOCKED' ? 'blocked' : 'notRun';
    m.total++;
    m[k]++;
    tot.total++;
    tot[k]++;
    if (c.needsRetest) needsRetest++;
    if (c.updatedAt > last) last = c.updatedAt;
    if (c.testedByName && c.status !== 'NOT_RUN') {
      const t = testers.get(c.testedByName) ?? { count: 0, pass: 0, fail: 0, blocked: 0 };
      t.count++;
      if (k !== 'notRun') t[k]++;
      testers.set(c.testedByName, t);
    }
  }
  const done = tot.total - tot.notRun;
  const defectsByStatus: Record<string, number> = { OPEN: 0, FIXED: 0, RETEST_PASSED: 0, RETEST_FAILED: 0, CLOSED: 0 };
  for (const d of defects) defectsByStatus[d.status] = d._count._all;
  return {
    runId,
    ...tot,
    done,
    percentDone: tot.total ? Math.round((done / tot.total) * 1000) / 10 : 0,
    passRate: done ? Math.round((tot.pass / done) * 1000) / 10 : null,
    needsRetest,
    openDefects: defectsByStatus.OPEN + defectsByStatus.FIXED + defectsByStatus.RETEST_FAILED,
    defectsByStatus,
    modules: [...modules.entries()].map(([module, v]) => ({ module, ...v })),
    testers: [...testers.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count),
    recent: recent.map((e) => ({
      caseKey: e.runCase.caseKey,
      kind: e.kind,
      status: e.status,
      actorName: e.actorName,
      createdAt: e.createdAt.toISOString(),
    })),
    updatedAt: (recent[0]?.createdAt && recent[0].createdAt > last ? recent[0].createdAt : last).toISOString(),
  };
}
