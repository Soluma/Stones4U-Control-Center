# Phase 2 Implementation Report — Tasks 2.0, Files (R2), Appointments, Customer 360 v2

Built 2026-09-02, following `docs/platform-discovery/26-PHASE-2-BUILD-SPEC.md`
(written before any code, as instructed). Phase 1 remains unchanged and
in production — every change below is additive or a targeted extension of
an already-prepared-but-unused Phase-1 field. Not committed to git (see
§22 "Git" below) and **not deployed to production** — staging only, per
explicit instruction.

## 1. Models

New Prisma models: `TaskComment`, `TaskChecklistItem`, `Appointment`,
`CustomerTag`, `CustomerTagAssignment`. Extended: `Task` (+`tags`,
+`reminderAt`, +comment/checklist relations), `Activity`/`ActivityType`
(+`FILE_UPLOADED`/`FILE_REMOVED`/`APPOINTMENT_*`/`TASK_UPDATED`/
`TASK_COMMENT_ADDED`/`TASK_CHECKLIST_COMPLETED`, +`relatedFileId`/
`relatedAppointmentId`), `File` (reshaped from its Phase-1 schema-only
form: `fileName`→`originalFilename`, `sizeBytes`→`byteSize`, +`title`,
+`description`, +`deletedAt`, +`updatedAt`, +explicit relations),
`CustomerProfile` (`tags String[]` **removed** — replaced by the
`CustomerTagAssignment` relation; see §2 for why this was safe), `User`
(+back-relations for the above). Full detail and rationale:
`docs/platform-discovery/26-PHASE-2-BUILD-SPEC.md` §3–4.

## 2. Migrations

One migration: `prisma/migrations/20260902114811_phase2_tasks_files_appointments_tags/migration.sql`.
Generated via `prisma migrate diff` (non-interactive `migrate dev` isn't
supported in this environment) and reviewed by hand before applying —
almost entirely `CREATE TABLE`/`ADD COLUMN`/`ADD ENUM VALUE`/`ADD
CONSTRAINT`. The only two destructive statements:

- `ALTER TABLE "CustomerProfile" DROP COLUMN "tags"` — verified **empty
  everywhere** before migrating (local dev DB: 0 of 1 customer rows had a
  non-empty array; staging: 0 of N — checked via a direct query, not
  assumed) — no tag-management UI ever existed in Phase 1 to populate it.
- `ALTER TABLE "File" DROP COLUMN "fileName", DROP COLUMN "sizeBytes"`
  (renamed, replaced by `originalFilename`/`byteSize`) — the `File` table
  had **zero rows** in every environment (schema-only since Phase 1, no
  code ever read or wrote `prisma.file` before this phase) — verified
  directly, not assumed.

Applied locally via `prisma migrate deploy` (not `migrate dev`, per
instruction) against the local dev database, then again against staging
through the existing `release_command` mechanism during `fly deploy`.
**Not applied to production.**

## 3. Routes

18 new/changed API routes and 2 new pages — full table in
`docs/platform-discovery/26-PHASE-2-BUILD-SPEC.md` §5. Highlights:
`/tasks/[id]` (new detail page), `/api/tasks/[id]/comments`,
`/api/tasks/[id]/checklist(/[itemId])`, `/api/customers/[id]/appointments`,
`/api/appointments/[id]`, `/api/appointments/upcoming`,
`/api/customers/[id]/files`, `/api/files/[id]`, `/api/customer-tags(/[id])`,
`/api/customers/[id]/tags`. `/api/tasks/[id]` GET added (didn't exist in
Phase 1); its PATCH extended to also accept title/description/priority/
dueAt/reminderAt/tags alongside the existing status/assignedToId shape.
`/api/search` extended with a `tasks` group.

Every write route uses `requireWriteAccess()` (VIEWER blocked) plus an
entity-specific owner/assignee/admin check where applicable — verified
live on staging (§8).

## 4. UI

New: `TaskDetailView.tsx` (title/description/priority/deadline edit,
checklist, comments, status actions), `AppointmentsPanel.tsx`,
`FilesPanel.tsx` (drag-and-drop + file picker, type icon, uploader,
open/download, delete), `AccountManagerControl.tsx`,
`CustomerTagsControl.tsx` (assign/unassign/create, color-aware chips).
Changed: `CustomerHeader.tsx` (quick actions row now Notitie/Taak/Afspraak/
Bestand, tags, accountmanager), `customers/[id]/page.tsx` (2 new tabs:
Afspraken/Bestanden; overview tab gained openstaande-taken/komende-
afspraken/recente-bestanden blocks alongside the existing orders/activity),
`tasks/TasksList.tsx` (clickable rows → detail page, text search, sort),
`ActivityTimelineView.tsx` (9 new icon/tint mappings), `page.tsx` (dashboard:
komende afspraken + recente CRM-activiteit sections), `CommandPalette.tsx`
(generalized beyond customer-only selection; + tasks group from the API +
a static, client-side-only navigation group). No new design system —
every new component reuses the existing `cc-card`/`cc-btn-*`/`Dialog`/
`Badge`/`StatusDot`/`Button`/`Input` primitives from Phase 1's UI/UX pass.

## 5. R2 / file storage

`src/integrations/storage/r2.ts` — S3-compatible client (`@aws-sdk/client-s3`
+ `@aws-sdk/s3-request-presigner`, new dependencies) against Cloudflare R2.
Same graceful-degradation shape as the telephony/exact adapters:
`isStorageConfigured()` checks `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/
`R2_SECRET_ACCESS_KEY`/`R2_BUCKET_NAME`; every file route returns a clean
503 "Bestandsopslag is nog niet geconfigureerd." when absent — verified
live on both local dev and staging (§8), since **no Cloudflare R2 bucket
exists yet** (no Cloudflare account access in this environment — an
operational step for a human, exactly like the Shopify custom app was in
Phase 1). Upload is server-side (browser posts raw bytes to a Next.js
route; the server validates and performs the R2 `PutObject` itself — no
presigned PUT URL or credential ever reaches the client). Download is a
short-lived (60s) server-generated presigned GET URL with
`Content-Disposition` set server-side (`inline` only for images/PDF,
`attachment` for everything else) — no public bucket, no permanent public
URL stored anywhere. Storage keys are `files/{randomUUID()}{ext}`, never
derived from the original filename.

`src/platform/security/file-validation.ts` — allowlist-only validation
(images/PDF/Office docs; **SVG rejected outright**, not merely
unlisted), magic-byte sniffing against the declared MIME type (catches a
spoofed `Content-Type`), filename sanitization (strips path separators/
control characters/quotes), 20MB size cap.

## 6. Tests

37 new tests across 6 files (85 total, up from 47): `file-validation.test.ts`
(11 — allowlist, magic-byte mismatch, SVG rejection, size limit, filename
sanitization), `r2-adapter.test.ts` (5 — not-configured fail-safe for every
operation), `files.test.ts` (5 — authorization for update/delete,
soft-delete exclusion from listings), `appointments.test.ts` (6 — CRUD,
creator/assignee/admin permissions, upcoming-list filtering),
`task-comments-checklist.test.ts` (7 — comments, checklist incl. the
"no Activity per toggle, one when fully complete" rule, task-detail update,
Phase-1-task backwards compatibility, `searchTasks` role-scoping),
`customer-tags.test.ts` (4 — create/assign/unassign/delete permissions,
idempotent assignment). `tests/fixtures.ts` extended with Phase-2-aware
cleanup (Appointment/File/CustomerTagAssignment cascade from
`cleanupCustomerProfile`; CustomerTag/File defensively cleaned in
`cleanupUser` since those FKs don't cascade).

```
npm run typecheck   → clean
npm run lint          → clean
npm run test            → 18 files, 85 tests, all passing
npm run build              → succeeds (Turbopack), all new routes compile
```

A full local manual smoke test (`npm run dev`, a throwaway local AGENT/
VIEWER test account) was also run end-to-end before touching staging —
see §8 for what was verified there and on staging.

## 7. Staging deployment

See `docs/deployment/PHASE-2-STAGING.md` for the full runbook. Summary:
deployed to `stones4u-control-center-staging` (unchanged app, unchanged
database — the existing staging Managed Postgres cluster) via
`fly deploy -c fly.toml`; `release_command = npx prisma migrate deploy`
applied the Phase 2 migration cleanly on the first attempt (the staging
cluster was already warm from prior use, unlike the production deploy's
first-attempt TLS delay documented in
`docs/build/PHASE-1-PRODUCTION-DEPLOYMENT.md`). Both machines healthy,
`GET /api/health` → 200, throughout.

## 8. Staging smoke test result

An existing real `ADMIN` account (`fons@verkoelengroep.nl`) already exists
on staging — bootstrapped by the user independently after the earlier
staging-deployment task, its password unknown to (and never requested by)
this session. To exercise the write paths this task's smoke-test checklist
requires, two throwaway accounts were created **directly in the staging
database** (`phase2-smoke-test@stones4u.local`, AGENT; `phase2-smoke-
viewer@stones4u.local`, VIEWER) using the app's own `hashPassword`
function (so they authenticate through the normal login flow, not a
bypass) — staging is explicitly the environment for exactly this kind of
verification, this is not production, and both accounts plus every row
they created were fully removed immediately after testing (verified via a
follow-up query). This is disclosed here in full rather than glossed over.

**TASKS** — PASS. A Phase-1-shaped task continues to work (no code path
assumes tags/checklist/comments exist — verified by the equivalent unit
test, §6). Created a task, opened `/tasks/[id]` (200), added a checklist
item, added a comment, updated title/priority/tags, completed then
reopened it, confirmed the central `/tasks` list and the `overdue` filter
still respond correctly.

**FILES** — PASS (for what's currently deployable). Upload correctly
returns `503 {"error":"Bestandsopslag is nog niet geconfigureerd."}` on
staging (no R2 credentials there either — see §5). The `/customers/[id]?tab=files`
page itself renders (200). Actual upload/download/delete against real R2
objects could not be exercised in this environment — see "Known
limitations".

**APPOINTMENTS** — PASS. Created, updated (title), completed, and
separately created+cancelled a second appointment; each transition
produced the correct `AppointmentStatus` and the correct Activity Timeline
event. `/api/appointments/upcoming` correctly excluded the now-completed/
cancelled appointments.

**CUSTOMER 360** — PASS. Created and assigned a `CustomerTag`, set an
accountmanager via `AccountManagerControl`'s PATCH — both changes appeared
correctly (tag chip, `CUSTOMER_PROFILE_UPDATED` activity).

**TIMELINE** — PASS. A single customer's timeline correctly showed, in
order, every Phase 2 event type produced during the test
(`APPOINTMENT_CREATED`/`_UPDATED`/`_COMPLETED`/`_CANCELLED`,
`TASK_STATUS_CHANGED`/`_COMPLETED`/`_UPDATED`/`_COMMENT_ADDED`/`_CREATED`,
`CUSTOMER_PROFILE_UPDATED`) alongside the pre-existing Phase-1 types — no
duplicates, correct chronological order.

**DASHBOARD** — PASS. "Komende afspraken" and "Recente CRM-activiteit"
both rendered real data from the test session.

**Security** — PASS. VIEWER got `403` on every write route tested
(task/appointment/tag creation, file upload); a non-admin AGENT got `403`
attempting to delete a tag *type* (ADMIN-only per spec §7); unauthenticated
`/api/admin/shopify-scopes` → `401`, VIEWER/AGENT → `403` (still ADMIN-only,
unchanged); session cookie confirmed `Secure; HttpOnly; SameSite=lax`;
`/api/health` leaks nothing.

**Logs** — PASS. `fly logs` reviewed post-deploy and post-smoke-test: no
password, hash, secret, or full connection string in any line.

## 9. Known limitations

1. **No live Cloudflare R2 bucket** — file upload/download/delete against
   real object storage has never been exercised end-to-end anywhere
   (local, staging, or production); only the "not configured" fail-safe
   path is verified. Provisioning a bucket + API token is an operational
   step outside this session's access (see "Exact manual steps").
2. Task comments have no edit/delete in Phase 2 (deliberate — append-only,
   see `docs/platform-discovery/26` §3).
3. Checklist reordering is add/toggle/remove only — no drag-to-reorder.
4. `Appointment.externalCalendarId` is a prepared, unused field (no
   Microsoft Graph/Google Calendar sync — explicitly out of scope).
5. Command-palette navigation group is a static client-side list, not
   server-driven.
6. Not deployed to production — staging only, per explicit instruction.

## 10. Exact manual steps still needed

1. Provision a Cloudflare R2 bucket + API token (Cloudflare account
   access required — not available in this session), then set
   `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/
   `R2_BUCKET_NAME` as Fly secrets on staging (and, once approved,
   production) — see `docs/deployment/PHASE-2-STAGING.md`.
2. Once R2 is configured, re-run the FILES portion of the staging smoke
   test against real uploads (image + PDF + rejected-type + oversized).
3. Review this report and the staging deployment, then decide on a
   production deploy — **not done in this task**, per explicit instruction.
