/* Generates openapi.json from the zod schemas. Run: npm run openapi */
import fs from 'node:fs';
import path from 'node:path';
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import * as S from '../src/schemas';

const r = new OpenAPIRegistry();
const bearer = r.registerComponent('securitySchemes', 'bearer', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
const sec = [{ [bearer.name]: [] }];

const json = (schema: z.ZodTypeAny, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const err = { description: 'Error', content: { 'application/json': { schema: S.ErrorBody } } };
const file = (mime: string) => ({ description: 'File', content: { [mime]: { schema: z.string().openapi({ format: 'binary' }) } } });
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const upload = { content: { 'multipart/form-data': { schema: z.object({ file: z.string().openapi({ format: 'binary' }) }) } } };
const id = (...names: string[]) => z.object(Object.fromEntries(names.map((n) => [n, z.string()])));

type M = 'get' | 'post' | 'patch' | 'delete' | 'put';
function add(method: M, p: string, opts: { id: string; tag: string; summary: string; auth?: boolean; params?: string[]; query?: z.ZodObject; body?: z.ZodTypeAny; upload?: boolean; res: Record<number, unknown> }) {
  r.registerPath({
    method,
    path: p,
    operationId: opts.id,
    tags: [opts.tag],
    summary: opts.summary,
    security: opts.auth === false ? [] : sec,
    request: {
      ...(opts.params ? { params: id(...opts.params) } : {}),
      ...(opts.query ? { query: opts.query } : {}),
      ...(opts.body ? { body: { content: { 'application/json': { schema: opts.body } } } } : {}),
      ...(opts.upload ? { body: upload } : {}),
    },
    responses: { ...(opts.res as object), 400: err, 401: err, 403: err, 404: err } as never,
  });
}

add('get', '/health', { id: 'health', tag: 'System', summary: 'Health check', auth: false, res: { 200: json(z.object({ status: z.string(), service: z.string(), version: z.string(), db: z.string(), storage: z.string(), time: z.string() })) } });

add('get', '/auth/providers', { id: 'authProviders', tag: 'Auth', summary: 'Enabled sign-in providers', auth: false, res: { 200: json(z.object({ providers: z.array(z.string()) })) } });
add('post', '/auth/login', { id: 'login', tag: 'Auth', summary: 'Sign in with email and password', auth: false, body: S.LoginBody, res: { 200: json(S.AuthResult) } });
add('get', '/auth/me', { id: 'me', tag: 'Auth', summary: 'Current user', res: { 200: json(S.User) } });
add('post', '/auth/invites', { id: 'createInvite', tag: 'Auth', summary: 'Invite a person (admin)', body: S.InviteBody, res: { 201: json(S.InviteResult) } });
add('get', '/auth/invites/{token}', { id: 'getInvite', tag: 'Auth', summary: 'Read an invite', auth: false, params: ['token'], res: { 200: json(S.InviteInfo) } });
add('post', '/auth/accept-invite', { id: 'acceptInvite', tag: 'Auth', summary: 'Accept an invite and set a password', auth: false, body: S.AcceptInviteBody, res: { 201: json(S.AuthResult) } });
add('get', '/users', { id: 'listUsers', tag: 'Users', summary: 'List users', res: { 200: json(z.array(S.User)) } });
add('patch', '/users/{id}', { id: 'updateUser', tag: 'Users', summary: 'Change role or access (admin)', params: ['id'], body: S.UpdateUserBody, res: { 200: json(S.User) } });

add('get', '/projects', { id: 'listProjects', tag: 'Projects', summary: 'List projects', res: { 200: json(z.array(S.Project)) } });
add('post', '/projects', { id: 'createProject', tag: 'Projects', summary: 'Create a project (admin)', body: S.ProjectBody, res: { 201: json(S.Project) } });
add('get', '/projects/{id}', { id: 'getProject', tag: 'Projects', summary: 'Get a project', params: ['id'], res: { 200: json(S.Project) } });
add('patch', '/projects/{id}', { id: 'updateProject', tag: 'Projects', summary: 'Update a project (admin)', params: ['id'], body: S.ProjectPatch, res: { 200: json(S.Project) } });
add('get', '/projects/{id}/cases', { id: 'listTemplateCases', tag: 'Templates', summary: 'Template cases in run order', params: ['id'], res: { 200: json(z.array(S.TemplateCase)) } });
add('post', '/projects/{id}/cases', { id: 'createTemplateCase', tag: 'Templates', summary: 'Add a template case (admin)', params: ['id'], body: S.TemplateCaseBody, res: { 201: json(S.TemplateCase) } });
add('patch', '/projects/{id}/cases/{caseId}', { id: 'updateTemplateCase', tag: 'Templates', summary: 'Edit a template case (admin)', params: ['id', 'caseId'], body: S.TemplateCaseBody.partial(), res: { 200: json(S.TemplateCase) } });
add('delete', '/projects/{id}/cases/{caseId}', { id: 'deleteTemplateCase', tag: 'Templates', summary: 'Delete a template case (admin)', params: ['id', 'caseId'], res: { 204: { description: 'Deleted' } } });
add('post', '/projects/{id}/import', { id: 'importTemplate', tag: 'Import and export', summary: 'Import an .xlsx tracker into the template', params: ['id'], upload: true, res: { 200: json(S.ImportResult) } });
add('get', '/projects/{id}/export', { id: 'exportTemplate', tag: 'Import and export', summary: 'Download the template as .xlsx', params: ['id'], res: { 200: file(XLSX) } });
add('get', '/projects/{id}/runs', { id: 'listRuns', tag: 'Runs', summary: 'Runs in a project', params: ['id'], res: { 200: json(z.array(S.Run)) } });
add('post', '/projects/{id}/runs', { id: 'createRun', tag: 'Runs', summary: 'Start a run (snapshots the template)', params: ['id'], body: S.RunBody, res: { 201: json(S.Run) } });
add('get', '/projects/{id}/defects', { id: 'listProjectDefects', tag: 'Defects', summary: 'Defects in a project', params: ['id'], query: z.object({ status: S.DefectStatusEnum.optional() }), res: { 200: json(z.array(S.Defect)) } });

add('get', '/runs/{id}', { id: 'getRun', tag: 'Runs', summary: 'Get a run', params: ['id'], res: { 200: json(S.Run) } });
add('patch', '/runs/{id}', { id: 'updateRun', tag: 'Runs', summary: 'Edit run details (admin, not after sign-off)', params: ['id'], body: S.RunPatch, res: { 200: json(S.Run), 423: err } });
add('get', '/runs/{id}/cases', { id: 'listRunCases', tag: 'Runs', summary: 'Cases in a run', params: ['id'], res: { 200: json(z.array(S.RunCase)) } });
add('get', '/runs/{id}/stats', { id: 'getRunStats', tag: 'Dashboard', summary: 'Live dashboard numbers', params: ['id'], res: { 200: json(S.RunStats) } });
add('get', '/runs/{id}/events', { id: 'runEvents', tag: 'Dashboard', summary: 'Server-sent events for a run. Pass access_token as a query value', params: ['id'], query: z.object({ access_token: z.string() }), res: { 200: { description: 'text/event-stream', content: { 'text/event-stream': { schema: z.string() } } } } });
add('get', '/runs/{id}/defects', { id: 'listRunDefects', tag: 'Defects', summary: 'Defects in a run', params: ['id'], res: { 200: json(z.array(S.Defect)) } });
add('post', '/runs/{id}/import-results', { id: 'importResults', tag: 'Import and export', summary: 'Import results from a filled .xlsx tracker', params: ['id'], upload: true, res: { 200: json(S.ImportResult), 423: err } });
add('post', '/runs/{id}/import-docx', { id: 'importDocx', tag: 'Import and export', summary: 'Import screenshots from a .docx, matched by case ID', params: ['id'], upload: true, res: { 200: json(S.ImportResult), 423: err } });
add('get', '/runs/{id}/export', { id: 'exportRun', tag: 'Import and export', summary: 'Download the run as the .xlsx tracker', params: ['id'], res: { 200: file(XLSX) } });
add('get', '/runs/{id}/report', { id: 'getReport', tag: 'Audit', summary: 'Audit report data', params: ['id'], res: { 200: json(S.AuditReport) } });
add('get', '/runs/{id}/report.pdf', { id: 'getReportPdf', tag: 'Audit', summary: 'Audit report PDF', params: ['id'], res: { 200: file('application/pdf') } });
add('get', '/runs/{id}/audit-log', { id: 'getAuditLog', tag: 'Audit', summary: 'Every change in the run', params: ['id'], res: { 200: json(z.array(S.AuditEntry)) } });
add('post', '/runs/{id}/signoff', { id: 'signOff', tag: 'Audit', summary: 'Sign off and lock the run (admin)', params: ['id'], body: S.SignOffBody, res: { 200: json(S.Run), 423: err } });
add('get', '/runs/{id}/share-links', { id: 'listShareLinks', tag: 'Audit', summary: 'Client share links (admin)', params: ['id'], res: { 200: json(z.array(S.ShareLink)) } });
add('post', '/runs/{id}/share-links', { id: 'createShareLink', tag: 'Audit', summary: 'Create an expiring read-only link (admin)', params: ['id'], body: S.ShareLinkBody, res: { 201: json(S.ShareLink) } });
add('delete', '/share-links/{id}', { id: 'revokeShareLink', tag: 'Audit', summary: 'Revoke a share link (admin)', params: ['id'], res: { 204: { description: 'Revoked' } } });

add('get', '/cases/{id}', { id: 'getRunCase', tag: 'Testing', summary: 'One case in a run', params: ['id'], res: { 200: json(S.RunCase) } });
add('get', '/cases/{id}/history', { id: 'getCaseHistory', tag: 'Testing', summary: 'Append-only history of a case', params: ['id'], res: { 200: json(z.array(S.CaseEvent)) } });
add('post', '/cases/{id}/result', { id: 'recordResult', tag: 'Testing', summary: 'Mark Pass, Fail or Blocked. Fail opens a defect', params: ['id'], body: S.ResultBody, res: { 200: json(S.ResultOutcome), 409: err, 423: err } });
add('post', '/cases/{id}/attachments', { id: 'presignAttachment', tag: 'Testing', summary: 'Get an upload URL for a screenshot', params: ['id'], body: S.PresignBody, res: { 201: json(S.PresignResult), 423: err } });
add('post', '/attachments/{id}/confirm', { id: 'confirmAttachment', tag: 'Testing', summary: 'Confirm a screenshot after upload', params: ['id'], res: { 200: json(S.Attachment) } });

add('get', '/defects/{id}', { id: 'getDefect', tag: 'Defects', summary: 'Get a defect', params: ['id'], res: { 200: json(S.Defect) } });
add('patch', '/defects/{id}', { id: 'updateDefect', tag: 'Defects', summary: 'Assign, edit, close or reopen', params: ['id'], body: S.DefectPatch, res: { 200: json(S.Defect), 409: err, 423: err } });
add('post', '/defects/{id}/fix', { id: 'fixDefect', tag: 'Defects', summary: 'Mark fixed with a reference. Asks testers to retest', params: ['id'], body: S.FixBody, res: { 200: json(S.Defect), 409: err, 423: err } });

add('get', '/public/audit/{token}', { id: 'publicReport', tag: 'Public', summary: 'Read-only client report by share token', auth: false, params: ['token'], res: { 200: json(S.AuditReport.extend({ shareExpiresAt: z.string() })) } });
add('get', '/public/audit/{token}/pdf', { id: 'publicReportPdf', tag: 'Public', summary: 'Client report PDF by share token', auth: false, params: ['token'], res: { 200: file('application/pdf') } });

const doc = new OpenApiGeneratorV31(r.definitions).generateDocument({
  openapi: '3.1.0',
  info: { title: 'VAICS UAT API', version: '0.1.0', description: 'Backend for the VAICS UAT app.' },
  servers: [{ url: 'http://localhost:4000' }],
});
const out = path.join(__dirname, '..', 'openapi.json');
fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote ${out} (${Object.keys(doc.paths ?? {}).length} paths)`);
