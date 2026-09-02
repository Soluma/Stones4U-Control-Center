# Phase 1 — First Staging Deployment

Performed 2026-09-02. Staging / first production-like deployment of the
Stones4U Control Center Phase 1 build to Fly.io. See
`docs/deployment/FLY-STAGING.md` for the reusable operational runbook this
record follows — this file is the point-in-time account of what actually
happened on this first run.

## What was deployed

| | |
|---|---|
| Commit | `1799ff6a1be0232b5a742b30d9008bb80c5f50ec` (`main`, matches `origin/main` at deploy time) |
| Fly app | `stones4u-control-center-staging` |
| Staging URL | `https://stones4u-control-center-staging.fly.dev` |
| Region | `ams` |
| Fly release | `v1` |
| Image | `registry.fly.io/stones4u-control-center-staging:deployment-01M1GTF0V9ZEZB4EW9Y1KHJ32Q` (~672MB) |
| Database | Fly Managed Postgres, cluster `stones4u-cc-staging-db` (id `9g6y30wdpnmrv5ml`), region `ams`, plan Basic — dedicated to this app, no other Stones4U system reads or writes it |

## Pre-flight (before touching any infrastructure)

- `git status` — clean, `main` up to date with `origin/main`.
- `git log -3` — `1799ff6 fix: preserve line breaks in CRM notes`, `6cb8314 feat: refine Phase 1 Control Center UI and UX`, `850f311 feat: establish Stones4U Control Center Phase 1`.
- `npm run typecheck && npm run lint && npm run test && npm run build` — all four green (47/47 tests) immediately before deployment.
- Fly CLI `v0.4.76`, authenticated as `stones4unl@gmail.com`. Docker Desktop 4.55.0 running. Node `v22.11.0`, npm `10.9.0`.
- `package-lock.json` verified to contain the full cross-platform optional-dependency matrix (13 `@node-rs/argon2-*` variants, 25 `@rollup/rollup-*` variants, including `linux-x64-musl`) — the critical fix from the earlier production-readiness review is still intact.
- `next.config.ts` already had `output: "standalone"` correctly enabled and explained.
- No `Dockerfile`/`fly.toml` existed yet — both written this session (see below and `docs/deployment/FLY-STAGING.md`).

## Docker image — built and dry-run tested locally before any Fly resource existed

`docker build` succeeded on the first structurally-correct attempt, but the **runtime image's tooling install needed three iterations** to get right — all found and fixed via an actual local dry run against a throwaway Postgres database (`cc_staging_dryrun`, inside the existing local `crm-postgres` container), not assumed:

1. First attempt: `tsx` silently failed to install (present in the `npm install` output's package count for `prisma` but not `tsx`/`dotenv`) because `NODE_ENV=production` was already set when installing into a directory whose `package.json` still listed `tsx`/`dotenv` under `devDependencies` — npm's documented devDependency-omission behavior, the same class of gotcha already flagged in `docs/build/PHASE-1-PRODUCTION-READINESS.md` §7.
2. Second attempt: installing into an isolated sibling directory (`/opt/tools`) with its own package.json avoided the devDependency bleed, and fixed the `tsx`/`prisma` **binary** lookup — but broke `import "dotenv/config"` inside `scripts/bootstrap-admin.ts`, because Node's module resolution walks up parent directories of the *importing file*, and `/opt/tools` is a sibling of `/app`, never an ancestor.
3. Final fix: rewrite `/app/package.json` in place (strip `devDependencies`) immediately after copying the standalone output, then `npm install --no-save prisma@6.19.3 tsx@4.23.13 dotenv@17.4.2` directly into `/app/node_modules` as ordinary `dependencies` — unaffected by `NODE_ENV`, correctly resolvable by both the CLI (`npx prisma`, `npm run bootstrap:admin`) and Node's module resolution. Verified: 52 packages total in the final image (vs. 373–483 when the devDependency tree leaked in).

Full local dry run (throwaway DB, never touching real data), after the fix:
- `npx prisma migrate deploy` → applied `20260901211016_init` cleanly.
- Container boot → `/api/health` → `200 {"status":"ok"}`.
- `npm run bootstrap:admin` (test credentials) → admin created; a second invocation correctly refused (`Er bestaan al 1 gebruiker(s)...`).
- Full auth cycle: wrong password → `401`; correct login → `200` + session cookie; authenticated `/` → `200`; unauthenticated `/` → `307`; `/api/admin/shopify-scopes` without Shopify configured → generic safe error, real cause (`ShopifyConfigError: SHOPIFY_SHOP_DOMAIN ontbreekt`) logged server-side only, confirmed via `docker logs` — no secret in the response.

A small, directly-scoped fix was made to `src/app/api/health/route.ts` during this pass: the failure branch previously returned `{status:"error", error: String(error)}}`, which can include the raw datasource connection string for a Prisma initialization error. Changed to log the full error server-side (`console.error("health_check_db_error", error)`) and return only `{status:"error"}` to the caller — directly required by this deployment task's own health-endpoint constraint ("mag geen secrets tonen").

## Infrastructure created

- `fly apps create stones4u-control-center-staging --org personal` — name available on first try, no variant needed.
- `fly mpg create --name stones4u-cc-staging-db --org personal --region ams --plan Basic` — Fly **Managed** Postgres (not the classic unmanaged `fly postgres`, which the installed CLI itself now flags as unsupported/self-managed) — preferred per this task's own instructions and genuinely the better default for a first production-like deployment.
- `fly mpg attach 9g6y30wdpnmrv5ml --app stones4u-control-center-staging --variable-name DATABASE_URL` — wires the connection string directly into a Fly secret without it ever being manually typed into a command.
- `fly ips allocate-v4 --shared` + `fly ips allocate-v6` — **manual step required**: automatic IP provisioning failed on first deploy (`org_slug is only supported with private_v6 type`), so the app briefly had no public IP after the first `fly deploy` despite healthy machines. Fixed immediately; documented in `docs/deployment/FLY-STAGING.md` "Known operational notes" for any future first deploy of a new app.

**One disclosure**: `fly mpg create` and `fly mpg attach` both print the new database's connection string directly in their own confirmation output as part of their normal, non-configurable UX (not a flag I chose) — this happened twice in this session's tool output. The value was never typed by hand into any command, was immediately stored only as an encrypted Fly secret, and is not repeated anywhere in this document or in `docs/deployment/FLY-STAGING.md`. Since this is a brand-new staging database created in this same session with no data in it yet, no further action was taken; if this is a concern, the cluster's password can be rotated via `fly mpg users` before the app is used for anything real.

## Secrets set (names only)

`DATABASE_URL`, `SESSION_SECRET` (freshly generated via `openssl rand -hex 32`, staged and set without ever being echoed — verified by grepping the command output for the value pattern before proceeding), `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_API_VERSION`, `SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN` (the last five piped directly from the local `.env.local` — the same real Stones4U Shopify custom app already used in local dev — into `fly secrets import`, never displayed). `APP_ENV=staging` is a plain, non-secret `fly.toml` value.

## Migration result

`release_command = "npx prisma migrate deploy"` ran automatically as part of `fly deploy`, on its own dedicated one-off machine, before any `app` machine started. Log (via `fly logs`):
```
Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "fly-db", schema "public" at "pgbouncer.9g6y30wdpnmrv5ml.flympg.net"
1 migration found in prisma/migrations
Applying migration `20260901211016_init`
All migrations have been successfully applied.
```
Exactly one migration exists in this repo, purely additive (new tables/enums only) — no destructive change, no down-migration needed.

## Smoke test result

**A. Infrastructure** — PASS. App reachable over HTTPS (`https://stones4u-control-center-staging.fly.dev`, 200ms-scale response times), `GET /api/health` → `200 {"status":"ok"}` (confirms live database connectivity from the deployed app to the Managed Postgres cluster). Both `app` machines reached `started` with `1/1` health checks passing within seconds of boot (an initial single failed check right at cold-start is normal — the grace period covers it, not a restart loop; no subsequent failures in `fly logs`). Database reachable (proven by the health check and the migration having applied).

**B. Auth (unauthenticated / negative paths)** — PASS. `/login` → 200. Wrong-password login → 401. Malformed login body → 400 with a clean Dutch validation message. Unauthenticated `/` → 307 redirect to `/login`. Unauthenticated `/api/admin/users` → 401. Unauthenticated `/api/admin/shopify-scopes` → 401.

**B (continued) / C / D / E / F / G — deliberately not executed on staging.** No `User` row exists in the staging database yet. Per this task's own §9 ("Als bootstrap via Fly one-off tooling praktisch onveilig of onduidelijk is: STOP en documenteer de exacte handmatige command sequence"): the first ADMIN credential is a real, usable production-like credential, and the only way to hand it to the user without either (a) me generating and permanently knowing a working admin password for a real system, or (b) me printing a freshly-generated password into this transcript as the sole way for the user to ever learn it, is for **the user to type their own choice of email/password directly into `fly ssh console` themselves** — nothing I could do server-side avoids one of those two outcomes. The exact command is in `docs/deployment/FLY-STAGING.md` "Bootstrap admin". Everything that requires an authenticated session — ADMIN login, Shopify customer search/Customer 360/orders, notes (including the line-break regression fix), tasks, activity timeline, admin user management, VIEWER role-guard checks, and the 1366/1920 GUI pass — is consequently **not yet exercised against staging** and is the immediate next step (see below), not a failure.

The bootstrap mechanism itself **was** fully verified — see "Docker image" above: built, dry-run tested locally end-to-end (create, refuse-on-second-run, full login/logout cycle) against a throwaway database before this image was ever pushed to Fly.

## Shopify end-to-end status

**Not yet independently verified against staging**, for the same reason as above — the only route that exercises the Shopify client (`/api/admin/shopify-scopes`) requires an authenticated ADMIN session. The credentials themselves are the same ones already proven working in local dev (real Stones4U `.myshopify.com` shop, client-credentials grant, ADR-006) and were transferred to the Fly secret store without modification. **Immediate next step**: after bootstrapping the first admin, log in and open `/api/admin/shopify-scopes` — confirm it returns a real scope-handle list with no token/secret in the response (the same check already performed against local dev in the earlier diagnostic-route phase).

## Database safety

- Staging data exists only in `stones4u-cc-staging-db` (Managed Postgres, dedicated to this app).
- No write occurred against `offerteapp-db`, `source2pos-prod-db`/`source2pos-dev`, `telefoon-db`, `transport-s4u-db`, `s4u-quote-db`, `s4u-import-db`, `customer-history-db`, or any other existing Fly Postgres/Managed Postgres cluster — confirmed by construction (a brand-new cluster was created and exclusively attached to this app; no other `DATABASE_URL` was ever referenced).
- All Shopify access from this deploy is read-only (Phase 1 has no mutation code path anywhere in `src/integrations/shopify/`, unchanged by this deployment).
- No sibling repository (`OfferteApp`, `s4u-quote-app`, `Kassa Systeem`, `TelefoonSysteem`) was read, written, or deployed to.

## Logging

`fly logs` reviewed for the full startup + migration sequence (the only activity so far, since no authenticated request has been made against staging yet — login/note/task-create log inspection is part of the deferred smoke-test steps above). Confirmed present: machine lifecycle events, the Prisma migration log (datasource **hostname** only — `pgbouncer.9g6y30wdpnmrv5ml.flympg.net` — never the credential), Next.js startup banner, health-check pass/fail events. Confirmed absent: any password, `SESSION_SECRET`, Shopify client secret, Shopify access token, or full session token.

## Rollback readiness

- Previous release to roll back to: none yet — this is `v1`, the first release. `fly releases --app stones4u-control-center-staging` will list subsequent ones going forward.
- Migration applied: `20260901211016_init` only, purely additive — a rollback to an (currently nonexistent) earlier release would need no down-migration.
- Staging database can be discarded and rebuilt at any time via `fly mpg destroy 9g6y30wdpnmrv5ml` (staging only, never confused with a production cluster since none exists yet) followed by the create/attach/deploy sequence in `docs/deployment/FLY-STAGING.md`.

## Known limitations

1. **No ADMIN user bootstrapped yet** — by design, deferred to the user (see "Smoke test result" above). Everything downstream of authentication is unverified on staging until this happens.
2. **Shopify end-to-end check against staging is pending** the same bootstrap step.
3. Fly's automatic IP provisioning failed on first deploy and required a manual `fly ips allocate-v4`/`allocate-v6` — documented as a known step for any future first deploy of a new Fly app under this account, not something specific to this codebase.
4. Image size (~672MB) is not yet optimized.
5. `fly mpg create`/`fly mpg attach` printed the new database connection string in their own CLI output during creation — see "Infrastructure created" above for the full disclosure and why no further action was taken.
6. No custom domain, no DNS change — by explicit instruction, only the standard `fly.dev` URL exists.
7. TelefoonSysteem/Exact adapters remain disabled (ADR-004, unchanged) — `TELEFOONSYSTEEM_*`/`EXACT_HISTORY_*` are correctly unset on staging.

## Remaining steps toward production

1. `fly ssh console --app stones4u-control-center-staging` → run `npm run bootstrap:admin` with a real email + a password of your own choosing (exact command in `docs/deployment/FLY-STAGING.md`).
2. Log in at `https://stones4u-control-center-staging.fly.dev/login` and complete the deferred smoke-test sections: Shopify customer search → Customer 360 → orders; notes (including a multi-line note, to confirm the line-break fix survives a real deploy) → edit; tasks (create/assign/complete); activity timeline ordering; admin user management + VIEWER role-guard negative tests; a full visual pass at 1366×768 and 1920×1080 watching for console/hydration errors.
3. Once staging is confirmed fully working end-to-end (step 2), decide and provision the actual **production** Fly app + Managed Postgres cluster (same procedure, a different app/cluster name — never reuse the staging database) — this is explicitly out of scope for this task (no production app was created).
4. Consider rotating the Managed Postgres password (`fly mpg users`) before any real customer-facing use, given the disclosure above — optional, since the value only ever reached this session's own tool output and the encrypted Fly secret store.
5. Everything else from the original Phase 1 "Exact remaining manual steps" list (`docs/build/PHASE-1-IMPLEMENTATION-REPORT.md` §9) still applies unchanged: TelefoonSysteem/Exact service-auth design, OfferteApp/s4u-quote-app read API, image-size optimization.
