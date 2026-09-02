# Phase 2 — Staging Deployment

Companion to `docs/deployment/FLY-STAGING.md` (which stays the general
staging runbook) and `docs/build/PHASE-2-IMPLEMENTATION-REPORT.md` (what
was built and tested). This file covers what's specific to the Phase 2
release: the migration and the new `R2_*` secrets.

## What changed operationally

- **Same app** (`stones4u-control-center-staging`), **same database**
  (Managed Postgres cluster `stones4u-cc-staging-db`) — no new
  infrastructure was created for Phase 2, only a schema migration against
  the existing database.
- **Deploy command unchanged**: `fly deploy --app stones4u-control-center-staging -c fly.toml`.
  `release_command = "npx prisma migrate deploy"` (already in `fly.toml`
  since Phase 1) applied the new migration automatically.

## New environment variables (names only)

| Variable | Status on staging | Notes |
|---|---|---|
| `R2_ACCOUNT_ID` | **Not set** | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | **Not set** | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | **Not set** | R2 API token secret |
| `R2_BUCKET_NAME` | **Not set** | Target bucket name |

Every file route degrades to a clean `503 {"error":"Bestandsopslag is nog
niet geconfigureerd."}` while these are unset — verified live (see the
implementation report §8). To enable real file storage on staging once a
bucket exists:

```
fly secrets set R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET_NAME=... --app stones4u-control-center-staging
```
(values never appear in this document, in commands typed into a shared
terminal, or in any commit — stage them with `--stage` and `fly deploy`,
or set directly; either way, never echo the values back).

## Migration applied

`prisma/migrations/20260902114811_phase2_tasks_files_appointments_tags/` —
see the implementation report §2 for the full review (what's additive vs.
the two verified-empty destructive column drops). Applied automatically
via `release_command` during `fly deploy`; confirmed via `fly logs`:
```
1 migration found in prisma/migrations
Applying migration `20260902114811_phase2_tasks_files_appointments_tags`
All migrations have been successfully applied.
```

Before migrating, both previously-unused fields being reshaped
(`CustomerProfile.tags`, the whole `File` table) were confirmed empty on
staging via a direct query run through `fly ssh console` — not assumed.

## Smoke test accounts

No committed or default credentials exist. Two throwaway accounts were
created directly in the staging database for this deployment's write-path
smoke test (`phase2-smoke-test@stones4u.local` / AGENT,
`phase2-smoke-viewer@stones4u.local` / VIEWER) via the app's own password
hashing, and were **fully deleted** immediately after testing — staging
has no lingering test accounts or test data as of this report. The
existing real ADMIN account on staging was not touched or logged into.

## Rollback

Identical mechanism to `docs/deployment/FLY-STAGING.md` — the Phase 2
migration is additive (new tables/columns) except the two verified-empty
drops above, so rolling the app back to the pre-Phase-2 image works
unmodified against the migrated database (it simply won't reference the
new tables/columns). No down-migration is provided or needed.

## Not done

Production deployment (`stones4u-control-center`) — explicitly out of
scope for this task. Production still runs Phase 1 only, unaffected by
anything in this document.
