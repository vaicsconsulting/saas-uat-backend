import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export const RoleEnum = z.enum(['ADMIN', 'TESTER', 'DEVELOPER', 'VIEWER']).openapi('Role');
export const CaseStatusEnum = z.enum(['NOT_RUN', 'PASS', 'FAIL', 'BLOCKED']).openapi('CaseStatus');
export const CaseStatusOrNull = z.union([CaseStatusEnum, z.null()]);
export const RunStatusEnum = z.enum(['ACTIVE', 'SIGNED_OFF']).openapi('RunStatus');
export const DefectStatusEnum = z
  .enum(['OPEN', 'FIXED', 'RETEST_PASSED', 'RETEST_FAILED', 'CLOSED'])
  .openapi('DefectStatus');

const iso = z.string().openapi({ format: 'date-time' });
const nstr = z.string().nullable();

export const ErrorBody = z
  .object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) })
  .openapi('Error');

export const User = z
  .object({ id: z.string(), email: z.string(), name: z.string(), role: RoleEnum, active: z.boolean(), createdAt: iso })
  .openapi('User');

export const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) }).openapi('LoginBody');
export const AuthResult = z.object({ token: z.string(), user: User }).openapi('AuthResult');
export const InviteBody = z
  .object({ email: z.string().email(), name: z.string().max(120).optional(), role: RoleEnum.default('TESTER') })
  .openapi('InviteBody');
export const InviteResult = z
  .object({ id: z.string(), email: z.string(), role: RoleEnum, expiresAt: iso, inviteUrl: z.string() })
  .openapi('InviteResult');
export const InviteInfo = z
  .object({ email: z.string(), name: nstr, role: RoleEnum, expiresAt: iso })
  .openapi('InviteInfo');
export const AcceptInviteBody = z
  .object({ token: z.string().min(10), name: z.string().min(1).max(120), password: z.string().min(8).max(200) })
  .openapi('AcceptInviteBody');
export const UpdateUserBody = z
  .object({ role: RoleEnum.optional(), active: z.boolean().optional(), name: z.string().min(1).max(120).optional() })
  .openapi('UpdateUserBody');

export const Project = z
  .object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    description: nstr,
    devBaseUrl: nstr,
    clientName: nstr,
    clientLogoUrl: nstr,
    caseCount: z.number().int(),
    runCount: z.number().int(),
    openDefects: z.number().int(),
    lastRun: z
      .object({ id: z.string(), name: z.string(), status: RunStatusEnum, done: z.number(), total: z.number() })
      .nullable(),
    createdAt: iso,
  })
  .openapi('Project');
export const ProjectBody = z
  .object({
    key: z
      .string()
      .min(2)
      .max(8)
      .regex(/^[A-Z][A-Z0-9]*$/, 'Use capital letters and digits, like VV'),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).nullish(),
    devBaseUrl: z.string().url().nullish(),
    clientName: z.string().max(200).nullish(),
    clientLogoUrl: z.string().url().nullish(),
  })
  .openapi('ProjectBody');
export const ProjectPatch = ProjectBody.partial().omit({ key: true }).openapi('ProjectPatch');

const caseFields = {
  caseKey: z.string().min(1).max(40),
  module: z.string().min(1).max(200),
  title: z.string().min(1).max(1000),
  role: z.string().max(200).nullish(),
  path: z.string().max(1000).nullish(),
  priority: z.string().max(10).default('P2'),
  type: z.string().max(40).default('Functional'),
  preconditions: z.string().max(5000).nullish(),
  steps: z.string().max(10000).nullish(),
  expected: z.string().max(10000).nullish(),
  testData: z.string().max(5000).nullish(),
};
export const TemplateCaseBody = z.object({ ...caseFields, sortOrder: z.number().int().optional() }).openapi('TemplateCaseBody');
export const TemplateCase = z
  .object({
    id: z.string(),
    caseKey: z.string(),
    module: z.string(),
    title: z.string(),
    role: nstr,
    path: nstr,
    priority: z.string(),
    type: z.string(),
    preconditions: nstr,
    steps: nstr,
    expected: nstr,
    testData: nstr,
    sortOrder: z.number().int(),
  })
  .openapi('TemplateCase');

export const Run = z
  .object({
    id: z.string(),
    projectId: z.string(),
    projectKey: z.string(),
    projectName: z.string(),
    name: z.string(),
    environment: z.string(),
    buildTag: nstr,
    baseUrl: nstr,
    clientName: nstr,
    clientLogoUrl: nstr,
    status: RunStatusEnum,
    startedAt: iso,
    endedAt: iso.nullable(),
    lockedAt: iso.nullable(),
    reportId: nstr,
    reportHash: nstr,
    total: z.number().int(),
    done: z.number().int(),
  })
  .openapi('Run');
export const RunBody = z
  .object({
    name: z.string().min(1).max(200),
    environment: z.string().min(1).max(60).default('dev'),
    buildTag: z.string().max(200).nullish(),
    baseUrl: z.string().url().nullish(),
    clientName: z.string().max(200).nullish(),
    clientLogoUrl: z.string().url().nullish(),
  })
  .openapi('RunBody');
export const RunPatch = RunBody.partial().openapi('RunPatch');

export const Attachment = z
  .object({ id: z.string(), fileName: z.string(), mimeType: z.string(), size: z.number().int(), url: z.string(), createdAt: iso })
  .openapi('Attachment');

export const RunCase = z
  .object({
    id: z.string(),
    runId: z.string(),
    caseKey: z.string(),
    module: z.string(),
    title: z.string(),
    role: nstr,
    path: nstr,
    priority: z.string(),
    type: z.string(),
    preconditions: nstr,
    steps: nstr,
    expected: nstr,
    testData: nstr,
    sortOrder: z.number().int(),
    status: CaseStatusEnum,
    actualResult: nstr,
    testedBy: nstr,
    testedAt: iso.nullable(),
    needsRetest: z.boolean(),
    version: z.number().int(),
    openDefect: z.object({ id: z.string(), code: z.string(), status: DefectStatusEnum }).nullable(),
    attachments: z.array(Attachment),
  })
  .openapi('RunCase');

export const CaseEvent = z
  .object({
    id: z.string(),
    kind: z.string(),
    status: CaseStatusOrNull,
    note: nstr,
    actorName: nstr,
    data: z.record(z.string(), z.unknown()).nullable(),
    attachments: z.array(Attachment),
    createdAt: iso,
  })
  .openapi('CaseEvent');

export const ResultBody = z
  .object({
    status: CaseStatusEnum.exclude(['NOT_RUN']),
    actualResult: z.string().max(2000).nullish(),
    version: z.number().int().min(0),
    attachmentIds: z.array(z.string()).max(20).default([]),
  })
  .openapi('ResultBody');
export const ResultOutcome = z
  .object({ case: RunCase, defect: z.lazy(() => Defect).nullable(), retest: z.boolean() })
  .openapi('ResultOutcome');

export const PresignBody = z
  .object({
    fileName: z.string().min(1).max(200),
    mimeType: z.string().regex(/^image\/(png|jpeg|gif|webp)$/, 'Images only (png, jpg, gif, webp)'),
    size: z.number().int().min(1),
  })
  .openapi('PresignBody');
export const PresignResult = z
  .object({
    attachmentId: z.string(),
    upload: z.object({ url: z.string(), method: z.literal('PUT'), headers: z.record(z.string(), z.string()) }),
  })
  .openapi('PresignResult');

export const Defect = z
  .object({
    id: z.string(),
    code: z.string(),
    runId: z.string(),
    runCaseId: z.string(),
    caseKey: z.string(),
    module: z.string(),
    title: z.string(),
    note: nstr,
    severity: z.string(),
    status: DefectStatusEnum,
    reportedBy: nstr,
    assignee: z.object({ id: z.string(), name: z.string() }).nullable(),
    fixRef: nstr,
    fixedBy: nstr,
    fixedAt: iso.nullable(),
    retestResult: CaseStatusOrNull,
    retestedBy: nstr,
    retestedAt: iso.nullable(),
    version: z.number().int(),
    createdAt: iso,
    attachments: z.array(Attachment),
  })
  .openapi('Defect');
export const DefectPatch = z
  .object({
    version: z.number().int().min(0),
    assigneeId: z.string().nullish(),
    severity: z.string().max(10).optional(),
    title: z.string().min(1).max(1000).optional(),
    note: z.string().max(5000).nullish(),
    status: z.enum(['OPEN', 'CLOSED']).optional(),
  })
  .openapi('DefectPatch');
export const FixBody = z
  .object({ version: z.number().int().min(0), fixRef: z.string().min(1).max(500), note: z.string().max(2000).nullish() })
  .openapi('FixBody');

export const ModuleStats = z
  .object({
    module: z.string(),
    total: z.number().int(),
    pass: z.number().int(),
    fail: z.number().int(),
    blocked: z.number().int(),
    notRun: z.number().int(),
  })
  .openapi('ModuleStats');
export const RunStats = z
  .object({
    runId: z.string(),
    total: z.number().int(),
    pass: z.number().int(),
    fail: z.number().int(),
    blocked: z.number().int(),
    notRun: z.number().int(),
    done: z.number().int(),
    percentDone: z.number(),
    passRate: z.number().nullable(),
    needsRetest: z.number().int(),
    openDefects: z.number().int(),
    defectsByStatus: z.record(z.string(), z.number().int()),
    modules: z.array(ModuleStats),
    testers: z.array(z.object({ name: z.string(), count: z.number().int(), pass: z.number().int(), fail: z.number().int(), blocked: z.number().int() })),
    recent: z.array(z.object({ caseKey: z.string(), kind: z.string(), status: CaseStatusOrNull, actorName: nstr, createdAt: iso })),
    updatedAt: iso,
  })
  .openapi('RunStats');

export const ShareLinkBody = z
  .object({ label: z.string().min(1).max(200), expiresInDays: z.number().int().min(1).max(365).default(14) })
  .openapi('ShareLinkBody');
export const ShareLink = z
  .object({
    id: z.string(),
    label: z.string(),
    tokenHint: z.string(),
    expiresAt: iso,
    revokedAt: iso.nullable(),
    lastUsedAt: iso.nullable(),
    createdAt: iso,
    url: z.string().optional(),
  })
  .openapi('ShareLink');

export const SignOffBody = z
  .object({
    signers: z
      .array(z.object({ name: z.string().min(1).max(120), role: z.string().min(1).max(120), company: z.string().max(200).nullish() }))
      .min(1)
      .max(10),
    confirm: z.literal(true),
  })
  .openapi('SignOffBody');
export const SignOff = z
  .object({ id: z.string(), name: z.string(), role: z.string(), company: nstr, signedAt: iso })
  .openapi('SignOff');

export const AuditEntry = z
  .object({ id: z.string(), action: z.string(), entity: z.string(), entityId: nstr, actorName: nstr, data: z.unknown(), createdAt: iso })
  .openapi('AuditEntry');

export const AuditReport = z
  .object({
    reportId: z.string(),
    reportHash: nstr,
    locked: z.boolean(),
    generatedAt: iso,
    brand: z.object({ company: z.string(), primary: z.string() }),
    client: z.object({ name: nstr, logoUrl: nstr }),
    project: z.object({ key: z.string(), name: z.string() }),
    run: z.object({
      name: z.string(),
      environment: z.string(),
      buildTag: nstr,
      baseUrl: nstr,
      windowStart: iso.nullable(),
      windowEnd: iso.nullable(),
    }),
    stats: RunStats,
    cases: z.array(
      z.object({
        caseKey: z.string(),
        module: z.string(),
        title: z.string(),
        priority: z.string(),
        type: z.string(),
        expected: nstr,
        status: CaseStatusEnum,
        actualResult: nstr,
        testedBy: nstr,
        testedAt: iso.nullable(),
        defectCodes: z.array(z.string()),
        screenshots: z.array(Attachment),
      }),
    ),
    defects: z.array(Defect),
    signOffs: z.array(SignOff),
    testers: z.array(z.string()),
  })
  .openapi('AuditReport');

export const ImportResult = z
  .object({ created: z.number().int(), updated: z.number().int(), skipped: z.number().int(), warnings: z.array(z.string()) })
  .openapi('ImportResult');

export type TResultBody = z.infer<typeof ResultBody>;
