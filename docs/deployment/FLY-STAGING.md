# Fly.io Staging Deployment — Stones4U Control Center

Operational reference for the staging environment. For what was actually
deployed in the first run (dates, commit SHA, smoke-test results, known
limitations), see `docs/build/PHASE-1-STAGING-DEPLOYMENT.md` — this file is
the reusable runbook, that one is the point-in-time record.

No secret values appear anywhere in this document — only variable names,
commands, and non-sensitive resource identifiers.

## App

| | |
|---|---|
| Fly app name | `stones4u-control-center-staging` |
| Region | `ams` (Amsterdam) |
| URL | `https://stones4u-control-center-staging.fly.dev` (standard `fly.dev` domain — no custom domain configured) |
| Process | single `app` process, `min_machines_running = 2` machines at `ams` (Fly's default HA behavior for `min_machines_running = 1`+ on first deploy) |
| VM size | `shared-cpu-1x`, 512MB |

## Build strategy

Multi-stage `Dockerfile` at the repo root:

1. **`deps`** — `node:22-alpine`, `npm ci` (full install, including devDependencies — needed to run the build itself).
2. **`builder`** — copies `deps`' `node_modules` + full source, runs `npx prisma generate` then `npm run build` (`next build --turbopack`, `output: "standalone"`).
3. **`runner`** — slim `node:22-alpine` runtime:
   - Copies the traced `.next/standalone` server + `.next/static` (this is what actually serves HTTP traffic).
   - Separately adds `prisma` (CLI), `tsx`, and `dotenv` as plain `dependencies` in a locally-rewritten `package.json` (with `devDependencies` stripped before install) — needed for `release_command` and the one-time admin bootstrap script, neither of which is reachable from any Next.js route so Next's standalone tracer never includes them. See the in-file comment in `Dockerfile` for why this couldn't just be `npm install` against the original `package.json` (it would reconcile the *entire* devDependency tree — eslint/tailwind/vitest/typescript — defeating a minimal image) or into a sibling directory (Node's module resolution for `import "dotenv/config"` walks up parent directories of the importing file, so a sibling `/opt/tools` is never found).
   - Copies `prisma/` (schema + migrations), `scripts/` (bootstrap script), `src/generated/` (the Prisma Client generated at build time — this app's `schema.prisma` outputs it to `src/generated/prisma`, not the default location), `tsconfig.json`.
   - Runs as a non-root user (`nextjs`, uid 1001).
   - `public/` is **not** copied — this repo currently has no `public/` directory. Add a `COPY --from=builder /app/public ./public` line if one is ever introduced.

`.dockerignore` excludes `.env`/`.env.local`/`.env.*.local`, `node_modules`, `.next`, `.git`, `docs`, `tests`, and other non-build files from the Docker build context — no local secret can ever reach the image this way.

Validated locally before every deploy in this repo's history so far: `docker build`, then a full dry run against a throwaway local Postgres database (`npx prisma migrate deploy`, server boot, `/api/health`, `npm run bootstrap:admin`, full login/logout/wrong-password flow) — see `docs/build/PHASE-1-STAGING-DEPLOYMENT.md` for the exact results of the first run.

## Health check

`GET /api/health` — runs `SELECT 1` against the database, returns `{"status":"ok"}` (200) or `{"status":"error"}` (503). The error path never echoes the underlying error (a Prisma initialization failure can include the datasource connection string) — the real error is logged server-side (`fly logs`) only.

`fly.toml` `[[http_service.checks]]`: `GET /api/health`, 15s interval, 10s grace period, 5s timeout.

## Database

- **Fly Managed Postgres** (`fly mpg`), cluster `stones4u-cc-staging-db` (id `9g6y30wdpnmrv5ml`), region `ams`, plan Basic (shared×2 CPU, 1GB RAM, 10GB disk).
- Attached to the app via `fly mpg attach <cluster-id> --app stones4u-control-center-staging --variable-name DATABASE_URL`, which sets `DATABASE_URL` directly as a Fly secret — the connection string is never typed manually into a terminal or file.
- **Exclusive to this app.** Not shared with OfferteApp, POS, TelefoonSysteem, or any other Stones4U system — no cross-app tables, no shared credentials.
- Reached over Fly's private network (`pgbouncer.<cluster-id>.flympg.net`) — not the local dev Docker Postgres (`crm-postgres`, port 55432), which stays local-only.

### Migration strategy

`fly.toml`:
```toml
[deploy]
  release_command = "npx prisma migrate deploy"
```
Fly runs `release_command` **once**, on a dedicated one-off machine, before any `app` machine is started or updated — migrations never race across multiple web machines, and a migration failure blocks the deploy (the new `app` machines never start).

To apply a new migration on a later deploy: commit the migration under `prisma/migrations/`, then `fly deploy` — no manual step needed.

## Environment variables (names only)

| Variable | Set via | Notes |
|---|---|---|
| `DATABASE_URL` | Fly secret (via `fly mpg attach`) | Staging's own Managed Postgres cluster |
| `SESSION_SECRET` | Fly secret (`openssl rand -hex 32`, generated fresh — never the local dev value) | HMAC pepper for session tokens |
| `SHOPIFY_SHOP_DOMAIN` | Fly secret | Same real Stones4U shop as local dev — Shopify is the one commercial source of truth (ADR-002); there is no separate Shopify "staging" store |
| `SHOPIFY_CLIENT_ID` | Fly secret | |
| `SHOPIFY_CLIENT_SECRET` | Fly secret | |
| `SHOPIFY_API_VERSION` | Fly secret | Matches the version already tested locally |
| `SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN` | Fly secret | Unused by any Phase 1 code path (no writes exist yet) — set for forward-compatibility with `assertShopifyShopIdentity()` |
| `APP_ENV` | `fly.toml` `[env]` (plain, non-secret) | `staging` |
| `NODE_ENV` | `Dockerfile` `ENV` (baked into the image) | `production` |
| `TELEFOONSYSTEEM_*`, `EXACT_HISTORY_*` | **Not set** | Adapters stay disabled by design (ADR-004) — unset env vars are the correct state, not a gap |

Set/verify secrets:
```
fly secrets list --app stones4u-control-center-staging   # names + digests only, never values
```

## Bootstrap admin

**Not automated on purpose.** The runtime image intentionally never holds or generates the first admin password — that credential is chosen and entered by a human, once, directly on the deployed machine:

```
fly ssh console --app stones4u-control-center-staging
BOOTSTRAP_ADMIN_EMAIL="you@stones4u.eu" BOOTSTRAP_ADMIN_PASSWORD="<a-strong-password-you-choose>" BOOTSTRAP_ADMIN_NAME="Your Name" npm run bootstrap:admin
exit
```

- Refuses unconditionally if any `User` row already exists (verified in the dry run — a second invocation correctly refused).
- No default/placeholder password exists anywhere in the codebase.
- No public registration endpoint exists.
- Log in once at `https://stones4u-control-center-staging.fly.dev/login`, then immediately change the password via `/settings` if you want it to differ from what you typed above (it's already known only to you at that point either way).

## Deploy

```
fly deploy --app stones4u-control-center-staging
```

Builds the image from `Dockerfile`, pushes it, runs `release_command`, then rolls out `app` machines. Watch progress at `https://fly.io/apps/stones4u-control-center-staging/monitoring`.

## Smoke tests (repeat after every deploy)

```
curl -s https://stones4u-control-center-staging.fly.dev/api/health          # expect {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" .../login                          # expect 200
curl -s -o /dev/null -w "%{http_code}\n" .../                               # expect 307 (unauthenticated redirect)
curl -s -o /dev/null -w "%{http_code}\n" -X POST .../api/auth/login \
  -H "Content-Type: application/json" -d '{"email":"x","password":"wrong"}' # expect 401
fly status --app stones4u-control-center-staging                            # both machines "started", checks passing
```

Then, after bootstrapping an admin (above): log in through the browser at 1366×768 and 1920×1080, and walk customer search → Customer 360 → orders → notes (including a multi-line note, to confirm line breaks survive — see `docs/build/PHASE-1-UI-UX-PASS.md`/the rich-text fix) → tasks → activity timeline → admin users → command palette, watching the browser console for hydration/console errors.

## Logs

```
fly logs --app stones4u-control-center-staging
```

Every log line was reviewed after the first deploy and confirmed to contain no password, `SESSION_SECRET`, Shopify client secret/access token, or full session token — only status codes, entity IDs, and (for the DB datasource line Prisma prints on migration) the **hostname**, never the credential.

## Rollback

1. `fly releases --app stones4u-control-center-staging` — find the previous working release/image.
2. `fly deploy --app stones4u-control-center-staging --image <previous-image-ref>` (or `fly releases rollback` if available in the installed CLI version).
3. No down-migration is needed for the one existing migration (`20260901211016_init`) — it is purely additive (new tables only); a rollback to older code works unmodified against a database that has since gained these tables.
4. To discard the staging database entirely and start fresh: `fly mpg destroy <cluster-id>` (destructive — staging data only, never run against the id backing production) then re-create + re-attach + re-deploy per this document. Never run this against a cluster you haven't confirmed by ID.

## Known operational notes

- Automatic IP provisioning failed on first deploy (`org_slug is only supported with private_v6 type`) — a shared IPv4 and a dedicated IPv6 were allocated manually (`fly ips allocate-v4 --shared`, `fly ips allocate-v6`). If a future `fly deploy` on a brand-new app hits the same error, this is the fix.
- Image size is ~672MB — not yet optimized (e.g. Alpine's package cache, npm's own cache layer). Acceptable for a first staging deploy; revisit if build/push time becomes a problem.
- `min_machines_running = 1` in `fly.toml`, but Fly created 2 machines on first deploy (its own default HA behavior). Set `min_machines_running = 0` and remove the second-machine step if staging cost should be minimized instead.
