# Phase 1 — First Production Deployment

Performed 2026-09-02, immediately following the staging deployment
(`docs/build/PHASE-1-STAGING-DEPLOYMENT.md`). See
`docs/deployment/FLY-PRODUCTION.md` for the reusable operational runbook —
this file is the point-in-time account of what actually happened on this
first production deploy.

## What was deployed

| | |
|---|---|
| Commit | `050c1c3811c6ccaf9d3871cff0618e4e39a11361` (`main`, matches `origin/main` at deploy time — this is the commit that added the staging deployment files; production and staging are running the exact same code) |
| Fly app | `stones4u-control-center` |
| Production URL | `https://stones4u-control-center.fly.dev` |
| Region | `ams` |
| Fly release | `v4` (`v1`–`v3` failed — see "First deploy" below) |
| Image | `registry.fly.io/stones4u-control-center:deployment-01M1GXB3T7CJ2BWHRWHYQC0PE4` (~672MB, byte-identical build to staging's image — same Dockerfile, same commit) |
| Database | Fly Managed Postgres, cluster `stones4u-cc-production-db`, region `ams`, plan Basic — dedicated to this app, shared with nothing else |

## Pre-flight

- `git status` — clean; `main` up to date with `origin/main`; staging's commit (`050c1c3`) already pushed, confirming the hard pre-flight requirement ("laatste staging-wijzigingen gecommit en gepusht") was already satisfied.
- `git log -5` — `050c1c3 feat: add Fly staging deployment`, `1799ff6 fix: preserve line breaks in CRM notes`, `6cb8314 feat: refine Phase 1 Control Center UI and UX`, `850f311 feat: establish Stones4U Control Center Phase 1`.
- `npm run typecheck && npm run lint && npm run test && npm run build` — all four green (47/47 tests) immediately before this deployment.
- `docker build` re-run at the current commit: **fully cache-hit, byte-identical image digest** to the one already deployed and dry-run-verified for staging — no new build risk introduced.
- Fly CLI authenticated, Docker running, staging app confirmed healthy (`/api/health` → 200) before touching production.
- Re-confirmed via `grep` across `src/integrations/shopify/`: no GraphQL mutation exists anywhere in the codebase — the only occurrences of the word "mutation" are doc comments explaining that Phase 1 is deliberately read-only.

## Infrastructure created

- `fly apps create stones4u-control-center --org personal` — preferred name available, no variant needed.
- `fly mpg create --name stones4u-cc-production-db --org personal --region ams --plan Basic` — plan choice reported *before* creation (see `docs/deployment/FLY-PRODUCTION.md` "Database" for the full justification: matches Phase 1's documented sizing expectations, backups already confirmed active at this tier, avoids overprovisioning an internal tool onto an enterprise-priced plan).
- `fly mpg attach <cluster-id> --app stones4u-control-center --variable-name DATABASE_URL` — connection string never typed by hand.
- `fly.production.toml` created as a **separate** config file from staging's `fly.toml` (not a shared file with an env override) — every `fly deploy` invocation explicitly names which file/app it targets, eliminating any risk of an accidental cross-deploy between environments.

**Same disclosure as staging**: `fly mpg create` prints the new cluster's connection string in its own confirmation output as non-configurable default behavior. This time the output was piped through a filter (`grep -v "postgresql://"`) before being read, so **the production database's connection string was never displayed in this session** — an improvement over the staging run, made specifically because of what was learned there.

## Secrets set (names only)

`DATABASE_URL`, `SESSION_SECRET` (freshly generated via `openssl rand -hex 32`, independent of staging's value — confirmed by comparing secret digests, which differ from staging's), `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_API_VERSION`, `SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN` (the Shopify secrets' digests are **identical** to staging's — confirming the same real Stones4U shop credentials were reused correctly, as instructed, since there is only one real shop). `APP_ENV=production` is a plain, non-secret `fly.production.toml` value. Every secret-setting command's output was checked (via `grep`) to confirm no value was ever echoed before proceeding.

## First deploy — 3 failed attempts, root-caused, then succeeded

`fly deploy --app stones4u-control-center -c fly.production.toml` failed on its first **three** attempts, each with the identical error during `release_command`:
```
Error: P1011: Error opening a TLS connection: unexpected EOF
```

This blocked the deploy correctly (no `app` machines ever started on a failed migration — exactly the intended safety behavior of `release_command`), so no partially-migrated or inconsistent state was ever exposed.

**Investigation performed** (not guessed):
1. Confirmed the cluster reported `status: ready` via `fly mpg status`.
2. Confirmed the cluster was genuinely healthy at the storage layer: `fly mpg backup list` showed a completed automatic backup.
3. Tested raw TLS connectivity via `openssl s_client -starttls postgres`, both through the public `pgbouncer.<id>.flympg.net` hostname and through `fly mpg proxy`'s direct WireGuard tunnel to the cluster's own address — both showed the same "unexpected eof" pattern.
4. **Ran the identical test against the staging cluster (already known, for hours, to work correctly)** — it showed the exact same "unexpected eof" pattern. This proved the `openssl -starttls postgres` test method itself is not a valid diagnostic for this pgbouncer TLS setup (a false positive), not evidence that the production cluster was actually broken — an important distinction that prevented chasing the wrong fix (e.g. recreating the cluster).
5. Waited (~90s, then longer) between attempts, reasoning that the production cluster's pgbouncer/TLS layer likely needed more warm-up time after creation than staging had organically had (staging's first migration ran roughly 50 minutes after its cluster was created, since Docker image building/testing happened in between; production's first attempt ran only ~5 minutes after cluster creation).
6. The 4th attempt (after the longest wait) succeeded cleanly.

**Conclusion**: a real but transient Managed-Postgres cluster warm-up delay, not a configuration or code defect — matches the general pattern of newly-provisioned managed database services needing a short period before their connection-pooling layer is fully ready, even though the control-plane API already reports `ready`. No code, secret, or config change was made to fix this — retrying after a longer wait was sufficient. Documented here as a known first-deploy timing consideration, not a recurring operational risk (subsequent deploys reuse the same, by-then-warm cluster).

Also noted: automatic Fly IP provisioning **succeeded** on the first successful attempt this time (unlike staging, where it failed and needed manual `fly ips allocate-v4`/`allocate-v6`) — no IP-related workaround was needed for production.

## Migration result

```
Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "fly-db", schema "public" at "pgbouncer.<production-cluster-id>.flympg.net"
1 migration found in prisma/migrations
Applying migration `20260901211016_init`
All migrations have been successfully applied.
```
Exactly the same single, purely-additive migration as staging (`20260901211016_init`) — no schema drift between environments.

## Deploy result

Both `app` machines reached `started` with `1/1` health checks passing within seconds of boot. `GET /api/health` → `200 {"status":"ok"}` from `https://stones4u-control-center.fly.dev`, confirming live connectivity from the deployed app to the production Managed Postgres cluster.

## Smoke test result

**A. Infrastructure** — PASS. HTTPS reachable, `/api/health` → 200, both machines `started`/healthy, `fly logs` shows a clean startup + migration sequence with a single expected transient health-check warning during cold boot (not a restart loop — no further failures follow it), database reachable (proven by the passing health check and applied migration).

**B. Auth (unauthenticated / negative paths)** — PASS. `/login` → 200. Wrong-password login → 401. Unauthenticated `/` → 307. Unauthenticated `/api/admin/users` → 401. Unauthenticated `/api/admin/shopify-scopes` → 401.

**B (continued) / C / D / E / F / G / H — deliberately not executed, per this task's own explicit instruction (§9)**: *"Het admin-wachtwoord moet door de gebruiker zelf worden gekozen. Claude mag geen wachtwoord genereren en tonen."* No `User` row exists in the production database. There is no way to satisfy that instruction while also completing an authenticated smoke test myself: either I generate a password and it never reaches the user (since I was told not to show it), or I show it (violating the instruction directly), or — the only option that respects both the instruction and the practical need for the user to actually have a working login — **the user types their own chosen email/password directly into `fly ssh console` themselves**. The exact command is in `docs/deployment/FLY-PRODUCTION.md` "Bootstrap admin". Everything requiring an authenticated session (ADMIN login, Shopify customer search/Customer 360/orders, the multi-line test note, the test task, activity timeline, admin user list, VIEWER guard checks, the visual GUI pass) is consequently the **immediate next step**, not a failure of this deployment.

## Shopify end-to-end status

**Not yet independently verified against production**, for the identical reason as above — `/api/admin/shopify-scopes` requires an authenticated ADMIN session. The credentials are the same real Stones4U shop already proven working in local dev and staging (confirmed via matching secret digests). **Immediate next step**: after bootstrap, log in and open `/api/admin/shopify-scopes`, then exercise real customer search / Customer 360 / orders through the UI.

## Security review

- No Shopify mutation exists anywhere in the code path deployed to production (re-confirmed by grep immediately before this deploy — see "Pre-flight").
- Cookies: `httpOnly`, `secure` (enforced since `NODE_ENV=production`), `sameSite=lax` — unchanged code from the already-reviewed `src/platform/auth/session.ts` (`docs/build/PHASE-1-PRODUCTION-READINESS.md` §2/3); not independently re-inspected via a real browser session yet since no login has occurred (part of the deferred smoke test above).
- `/api/health` never returns the underlying error/connection string (the fix made during the staging pass) — verified live: the endpoint currently returns only `{"status":"ok"}` in the healthy case.
- All `/api/admin/*` routes correctly return 401 without a session (verified live, see "Smoke test result" B above).
- No stack trace or internal error detail was observed in any response during this deployment's testing.

## Logging review

`fly logs --app stones4u-control-center` inspected for the full deploy + migration sequence (the only activity so far, since no authenticated request has occurred yet). Confirmed present: machine lifecycle events, the Prisma migration log (datasource **hostname** only, never the credential), Next.js startup banner, health-check events. Confirmed absent: any password, password hash, `SESSION_SECRET`, Shopify client secret, Shopify access token, full `DATABASE_URL`, session token, or customer PII (none of the deferred authenticated actions — login, Shopify search, note/task creation — have happened yet, so their log output is part of the deferred review too, not skipped here).

## Staging status

**Unaffected.** Confirmed live: `fly status --app stones4u-control-center-staging` shows both machines still `started` on the same image/version as before this task began (`deployment-01M1GTF0V9ZEZB4EW9Y1KHJ32Q`, unchanged), `GET /api/health` on the staging URL still returns `200 {"status":"ok"}`. No command in this session targeted `stones4u-control-center-staging`, its database, or `fly.toml`.

## Sibling repositories

Not touched. `git status --short` confirmed clean in `OfferteApp/`, `s4u-quote-app/`, `TelefoonSysteem/`; `Kassa Systeem/` shows only its own pre-existing, unrelated untracked `mapi-demo-1.35-release/` directory (present before this task, not created by it).

## Known limitations

1. **No ADMIN user bootstrapped yet** — by explicit design (see "Smoke test result"). Everything downstream of authentication is unverified on production until the user completes the bootstrap step.
2. **Shopify end-to-end check against production is pending** the same bootstrap step.
3. First deploy required 3 retries due to a transient Managed Postgres warm-up delay (fully root-caused, see "First deploy" above) — not expected to recur on subsequent deploys against the now-warm cluster.
4. Exact backup retention / PITR window for the Basic MPG plan is not stated as a single number in Fly's current public docs — verify via `fly mpg backup list <cluster-id>` before relying on a specific recovery-point-objective figure (documented in `docs/deployment/FLY-PRODUCTION.md`).
5. Image size (~672MB) not yet optimized — same as staging, not production-specific.
6. No custom domain, no DNS change — by explicit instruction.
7. TelefoonSysteem/Exact adapters remain disabled (ADR-004, unchanged) — correctly unset on production.

## Exact remaining manual steps

1. `fly ssh console --app stones4u-control-center` → choose your own email + password → `npm run bootstrap:admin` (exact command in `docs/deployment/FLY-PRODUCTION.md`).
2. Log in at `https://stones4u-control-center.fly.dev/login` and complete the deferred smoke-test sections: Shopify customer search → Customer 360 → orders (including older orders, if any, and confirm amounts/statuses render correctly) → a multi-line test note (`"Productie smoke test\nregel 2\n\nregel 4"` — confirm line breaks, refresh, edit, then delete/archive it) → a test task (assign to self, set priority + due date, complete it, confirm it persists on refresh, then clean it up) → activity timeline (confirm the Shopify order, note, and task events all appear with correct timestamps/ordering) → admin users page (confirm only your own real admin account exists, no stray test users) → a full visual pass at normal desktop resolution watching for console/hydration errors and overflow.
3. Re-run the security smoke test (§12 of the deployment task) once logged in: cookie flags via browser devtools, `/api/admin/shopify-scopes` reachable only as ADMIN with no secret in the response.
4. Re-review `fly logs` after the above to confirm login/Shopify-search/note-create/task-create log lines also contain no secrets or excess PII — the logging review above only covers pre-login activity.
5. Only after all of the above is confirmed: consider a custom domain (`crm.stones4u.eu` or similar) — explicitly not done in this task.
