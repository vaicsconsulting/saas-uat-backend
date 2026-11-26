# saas-uat-backend

API for VAICS UAT, the app co-devs use for manual user acceptance testing of the hub apps (IMS, V-Vault, V-Sign and more). It replaces the Excel tracker and the Word file of screenshots, and produces a client audit report.

Stack: Node 20+, TypeScript, Express 5, Prisma, PostgreSQL, S3 compatible storage (local disk in dev). Deployed on Railway.

## What it does

- Projects (one per app) with a case template in run order, grouped by module.
- Runs that copy the template, with environment, build tag and app URL.
- Results with Pass / Fail / Blocked, a one-line note and screenshots. Uses a `version` field so two testers cannot overwrite each other (HTTP 409).
- Fail opens a defect straight away (`DEF-001` per project). Developers mark it fixed with a reference, testers get a retest prompt, and the retest result updates the defect.
- Every case keeps an append-only history (`CaseEvent`). Every change is in `AuditLog`.
- Live dashboard numbers and server-sent events per run.
- Client audit report as JSON and PDF, shared by expiring, revocable read-only links.
- Sign-off locks the run (HTTP 423 on any change after) and stores a SHA-256 hash of the report content.
- Excel import and export in the VAICS tracker format (7 sheets, navy headers, Calibri, frozen header, autofilter, dropdowns). Word (.docx) import that matches screenshots to case IDs by nearby text.

## Run locally

```bash
cp .env.example .env          # set DATABASE_URL, DIRECT_URL, JWT_SECRET, SEED_ADMIN_*
npm install
npx prisma migrate deploy
npm run db:seed               # IMS, V-Vault, V-Sign, admin, sample V-Vault cases
npm run dev                   # http://localhost:4000/health
```

## Tests

Tests run against a real PostgreSQL database, which they reset.

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/saas_uat_test npm test
npm run typecheck
```

## API

- `openapi.json` in the repo root (also served at `GET /openapi.json`). Regenerate with `npm run openapi` after changing `src/schemas.ts`, then copy it to the frontend repo at `api/openapi.json` and run `npm run gen:api` there.
- Auth: `Authorization: Bearer <jwt>`. The SSE endpoint takes `?access_token=` because browsers cannot set headers on EventSource.
- Roles: Admin (projects, people, templates, sign-off, links), Tester (runs, results), Developer (fixes), Viewer (read only).

## Auth design

`src/auth/providers.ts` holds auth providers. Email and password with invite links is active now. Hub Portal SSO can be added later as another provider without changing routes. Users of this app are separate from tenant data.

## Storage

`STORAGE_DRIVER=local` keeps files in `LOCAL_STORAGE_DIR` and serves them with short-lived signed links. `STORAGE_DRIVER=s3` uses presigned PUT and GET URLs (AWS S3 ap-south-1 in prod, or any S3 compatible store via `S3_ENDPOINT`). The S3 bucket needs a CORS rule that allows `PUT` from the frontend origin with the `Content-Type` header.

## Railway

`railway.json` builds with `npm ci && npm run build` and starts with `npm run start:railway` (runs `prisma migrate deploy`, then the server). Health check: `/health`. Set the env vars from `.env.example` in Railway. With a connection pooler, `DATABASE_URL` is the pooled URL (add `?pgbouncer=true&connection_limit=5` for PgBouncer-style poolers) and `DIRECT_URL` is the direct URL used for migrations. Without a pooler, set both to the same URL. Run the seed once with `npx prisma db seed` from a Railway shell.
