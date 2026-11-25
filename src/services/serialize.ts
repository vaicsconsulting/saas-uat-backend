import type { Attachment, Defect, Project, Run, RunCase, User } from '@prisma/client';
import { storage } from '../storage';

const d = (v: Date | null | undefined) => (v ? v.toISOString() : null);

export function userDto(u: User) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, createdAt: u.createdAt.toISOString() };
}

export async function attachmentDto(a: Attachment) {
  return {
    id: a.id,
    fileName: a.fileName,
    mimeType: a.mimeType,
    size: a.size,
    url: await storage().viewUrl(a.storageKey),
    createdAt: a.createdAt.toISOString(),
  };
}

export function runDto(r: Run & { project: Pick<Project, 'key' | 'name'> }, counts: { total: number; done: number }) {
  return {
    id: r.id,
    projectId: r.projectId,
    projectKey: r.project.key,
    projectName: r.project.name,
    name: r.name,
    environment: r.environment,
    buildTag: r.buildTag,
    baseUrl: r.baseUrl,
    clientName: r.clientName,
    clientLogoUrl: r.clientLogoUrl,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    endedAt: d(r.endedAt),
    lockedAt: d(r.lockedAt),
    reportId: r.reportId,
    reportHash: r.reportHash,
    total: counts.total,
    done: counts.done,
  };
}

type CaseRow = RunCase & {
  testedBy?: Pick<User, 'name'> | null;
  attachments?: Attachment[];
  defects?: Pick<Defect, 'id' | 'code' | 'status' | 'createdAt'>[];
};

export async function runCaseDto(c: CaseRow) {
  const open = (c.defects ?? [])
    .filter((x) => x.status !== 'CLOSED' && x.status !== 'RETEST_PASSED')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return {
    id: c.id,
    runId: c.runId,
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
    status: c.status,
    actualResult: c.actualResult,
    testedBy: c.testedByName ?? c.testedBy?.name ?? null,
    testedAt: d(c.testedAt),
    needsRetest: c.needsRetest,
    version: c.version,
    openDefect: open ? { id: open.id, code: open.code, status: open.status } : null,
    attachments: await Promise.all((c.attachments ?? []).filter((a) => a.confirmed).map(attachmentDto)),
  };
}

export const runCaseInclude = {
  testedBy: { select: { name: true } },
  attachments: { where: { confirmed: true }, orderBy: { createdAt: 'asc' as const } },
  defects: { select: { id: true, code: true, status: true, createdAt: true } },
};

type DefectRow = Defect & {
  runCase: Pick<RunCase, 'caseKey' | 'module'>;
  reportedBy?: Pick<User, 'name'> | null;
  assignee?: Pick<User, 'id' | 'name'> | null;
  attachments?: Attachment[];
};

export async function defectDto(x: DefectRow, attachments: Attachment[] = []) {
  return {
    id: x.id,
    code: x.code,
    runId: x.runId,
    runCaseId: x.runCaseId,
    caseKey: x.runCase.caseKey,
    module: x.runCase.module,
    title: x.title,
    note: x.note,
    severity: x.severity,
    status: x.status,
    reportedBy: x.reportedBy?.name ?? null,
    assignee: x.assignee ? { id: x.assignee.id, name: x.assignee.name } : null,
    fixRef: x.fixRef,
    fixedBy: x.fixedByName,
    fixedAt: d(x.fixedAt),
    retestResult: x.retestResult,
    retestedBy: x.retestedBy,
    retestedAt: d(x.retestedAt),
    version: x.version,
    createdAt: x.createdAt.toISOString(),
    attachments: await Promise.all(attachments.filter((a) => a.confirmed).map(attachmentDto)),
  };
}

export const defectInclude = {
  runCase: { select: { caseKey: true, module: true } },
  reportedBy: { select: { name: true } },
  assignee: { select: { id: true, name: true } },
};
