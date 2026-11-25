import { Router } from 'express';
import multer from 'multer';
import { config } from '../config';
import { prisma } from '../db';
import { ah, badRequest, notFound } from '../lib/errors';
import { requireAuth, requireRole, ROLES } from '../auth/jwt';
import { ProjectBody, ProjectPatch, RunBody, TemplateCaseBody } from '../schemas';
import { audit } from '../services/audit';
import { createRun, runCounts } from '../services/runs';
import { defectDto, defectInclude, runDto } from '../services/serialize';
import { exportTemplate, importTemplate } from '../services/excel';
import type { DefectStatus } from '@prisma/client';

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Math.max(config.maxUploadMb, 25) * 1024 * 1024 } });

export const projectsRouter = Router();
projectsRouter.use('/projects', requireAuth);

async function projectDto(id: string) {
  const p = await prisma.project.findUnique({
    where: { id },
    include: { _count: { select: { cases: true, runs: true } }, runs: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!p) throw notFound('Project not found');
  const openDefects = await prisma.defect.count({ where: { projectId: id, status: { in: ['OPEN', 'FIXED', 'RETEST_FAILED'] } } });
  const last = p.runs[0];
  const counts = last ? (await runCounts([last.id])).get(last.id)! : null;
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    description: p.description,
    devBaseUrl: p.devBaseUrl,
    clientName: p.clientName,
    clientLogoUrl: p.clientLogoUrl,
    caseCount: p._count.cases,
    runCount: p._count.runs,
    openDefects,
    lastRun: last && counts ? { id: last.id, name: last.name, status: last.status, done: counts.done, total: counts.total } : null,
    createdAt: p.createdAt.toISOString(),
  };
}

const caseDto = (c: Awaited<ReturnType<typeof prisma.templateCase.findFirstOrThrow>>) => ({
  id: c.id,
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
  sortOrder: c.sortOrder,
});

projectsRouter.get(
  '/projects',
  ah(async (_req, res) => {
    const ps = await prisma.project.findMany({ where: { archived: false }, orderBy: { name: 'asc' }, select: { id: true } });
    res.json(await Promise.all(ps.map((p) => projectDto(p.id))));
  }),
);

projectsRouter.post(
  '/projects',
  requireRole(...ROLES.admin),
  ah(async (req, res) => {
    const body = ProjectBody.parse(req.body);
    const p = await prisma.$transaction(async (tx) => {
      const x = await tx.project.create({ data: body });
      await audit(tx, req.user, { projectId: x.id, action: 'project.created', entity: 'project', entityId: x.id, data: { key: x.key, name: x.name } });
      return x;
    });
    res.status(201).json(await projectDto(p.id));
  }),
);

projectsRouter.get('/projects/:id', ah(async (req, res) => res.json(await projectDto(String(req.params.id)))));

projectsRouter.patch(
  '/projects/:id',
  requireRole(...ROLES.admin),
  ah(async (req, res) => {
    const body = ProjectPatch.parse(req.body);
    const id = String(req.params.id);
    await prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id }, data: body });
      await audit(tx, req.user, { projectId: id, action: 'project.updated', entity: 'project', entityId: id, data: body });
    });
    res.json(await projectDto(id));
  }),
);

projectsRouter.get(
  '/projects/:id/cases',
  ah(async (req, res) => {
    const cases = await prisma.templateCase.findMany({ where: { projectId: String(req.params.id) }, orderBy: [{ sortOrder: 'asc' }, { caseKey: 'asc' }] });
    res.json(cases.map(caseDto));
  }),
);

projectsRouter.post(
  '/projects/:id/cases',
  requireRole(...ROLES.admin),
  ah(async (req, res) => {
    const body = TemplateCaseBody.parse(req.body);
    const projectId = String(req.params.id);
    const max = await prisma.templateCase.aggregate({ where: { projectId }, _max: { sortOrder: true } });
    const c = await prisma.$transaction(async (tx) => {
      const x = await tx.templateCase.create({ data: { ...body, projectId, sortOrder: body.sortOrder ?? (max._max.sortOrder ?? -1) + 1 } });
      await audit(tx, req.user, { projectId, action: 'case.created', entity: 'template_case', entityId: x.id, data: { caseKey: x.caseKey } });
      return x;
    });
    res.status(201).json(caseDto(c));
  }),
);

projectsRouter.patch(
  '/projects/:id/cases/:caseId',
  requireRole(...ROLES.admin),
  ah(async (req, res) => {
    const body = TemplateCaseBody.partial().parse(req.body);
    const projectId = String(req.params.id);
    const id = String(req.params.caseId);
    const c = await prisma.$transaction(async (tx) => {
      const ex = await tx.templateCase.findFirst({ where: { id, projectId } });
      if (!ex) throw notFound('Case not found');
      const x = await tx.templateCase.update({ where: { id }, data: body });
      await audit(tx, req.user, { projectId, action: 'case.updated', entity: 'template_case', entityId: id, data: body });
      return x;
    });
    res.json(caseDto(c));
  }),
);

projectsRouter.delete(
  '/projects/:id/cases/:caseId',
  requireRole(...ROLES.admin),
  ah(async (req, res) => {
    const projectId = String(req.params.id);
    const id = String(req.params.caseId);
    await prisma.$transaction(async (tx) => {
      const ex = await tx.templateCase.findFirst({ where: { id, projectId } });
      if (!ex) throw notFound('Case not found');
      await tx.templateCase.delete({ where: { id } });
      await audit(tx, req.user, { projectId, action: 'case.deleted', entity: 'template_case', entityId: id, data: { caseKey: ex.caseKey } });
    });
    res.status(204).end();
  }),
);

projectsRouter.post(
  '/projects/:id/import',
  requireRole(...ROLES.admin),
  upload.single('file'),
  ah(async (req, res) => {
    if (!req.file) throw badRequest('Attach an .xlsx file in the "file" field');
    const projectId = String(req.params.id);
    if (!(await prisma.project.findUnique({ where: { id: projectId } }))) throw notFound('Project not found');
    res.json(await importTemplate(req.user!, projectId, req.file.buffer));
  }),
);

projectsRouter.get(
  '/projects/:id/export',
  ah(async (req, res) => {
    const p = await prisma.project.findUnique({ where: { id: String(req.params.id) } });
    if (!p) throw notFound('Project not found');
    const buf = await exportTemplate(p.id);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${p.key}_Test_Template.xlsx"`);
    res.send(buf);
  }),
);

projectsRouter.get(
  '/projects/:id/runs',
  ah(async (req, res) => {
    const runs = await prisma.run.findMany({
      where: { projectId: String(req.params.id) },
      orderBy: { createdAt: 'desc' },
      include: { project: { select: { key: true, name: true } } },
    });
    const counts = await runCounts(runs.map((r) => r.id));
    res.json(runs.map((r) => runDto(r, counts.get(r.id)!)));
  }),
);

projectsRouter.post(
  '/projects/:id/runs',
  requireRole(...ROLES.testers),
  ah(async (req, res) => {
    const body = RunBody.parse(req.body);
    const run = await createRun(req.user!, String(req.params.id), body);
    const full = await prisma.run.findUniqueOrThrow({ where: { id: run.id }, include: { project: { select: { key: true, name: true } } } });
    res.status(201).json(runDto(full, (await runCounts([run.id])).get(run.id)!));
  }),
);

projectsRouter.get(
  '/projects/:id/defects',
  ah(async (req, res) => {
    const status = typeof req.query.status === 'string' ? (req.query.status as DefectStatus) : undefined;
    const list = await prisma.defect.findMany({
      where: { projectId: String(req.params.id), ...(status ? { status } : {}) },
      orderBy: { number: 'asc' },
      include: defectInclude,
    });
    res.json(await Promise.all(list.map((x) => defectDto(x))));
  }),
);
