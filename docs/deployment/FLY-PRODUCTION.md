# Fly.io Production Deployment — Stones4U Control Center

Operational reference for the production environment. For what was actually
deployed on the first run (dates, commit SHA, smoke-test results, known
limitations), see `docs/build/PHASE-1-PRODUCTION-DEPLOYMENT.md` — this file
is the reusable runbook, that one is the point-in-time record.

No secret values appear anywhere in this document — only variable names,
commands, and non-sensitive resource identifiers.

## Staging vs. production — fully independent

| | Staging | Production |
|---|---|---|
| Fly app | `stones4u-control-center-staging` | `stones4u-control-center` |
| Config file | `fly.toml` | `fly.production.toml` |
| Database | Managed Postgres `stones4u-cc-staging-db` | Managed Postgres `stones4u-cc-production-db` |
| `DATABASE_URL` | Own secret, own cluster | Own secret, own cluster — **never shared with staging** |
| `SESSION_SECRET` | Own value | Own, independently generated value — **never reused from staging** |
| `APP_ENV` | `staging` | `production` |
| URL | `stones4u-control-center-staging.fly.dev` | `stones4u-control-center.fly.dev` |

Nothing else differs — same `Dockerfile`, same image build process, same
Shopify credentials (there is one real Stones4U shop; ADR-002 makes Shopify
the single commercial source of truth, so there is no separate "staging
Shopify store" to point at instead).

Deploying to one never touches the other: `fly deploy -c fly.toml` only
ever targets `stones4u-control-center-staging` (the `app` name baked into
that file); `fly deploy -c fly.production.toml` only ever targets
`stones4u-control-center`.

## App

| | |
|---|---|
| Fly app name | `stones4u-control-center` |
| Region | `ams` (Amsterdam) |
| URL | `https://stones4u-control-center.fly.dev` (standard `fly.dev` domain — no custom domain configured) |
| Process | single `app` process, 2 machines at `ams` (`min_machines_running = 1` in config; Fly creates a second machine by default for HA/zero-downtime deploys) |
| VM size | `shared-cpu-1x`, 512MB |

## Build strategy

Identical multi-stage `Dockerfile` to staging — no production-specific
Dockerfile changes were needed or made. See `docs/deployment/FLY-STAGING.md`
"Build strategy" for the full design rationale (traced standalone server +
a separately-installed `prisma`/`tsx`/`dotenv` toolchain for migrations and
the one-time admin bootstrap script).

## Health check

`GET /api/health` — `SELECT 1` against the database, `{"status":"ok"}` (200)
or `{"status":"error"}` (503), never echoing the underlying error (fixed
during the staging pass specifically because a Prisma initialization error
can include the datasource connection string — see
`docs/build/PHASE-1-STAGING-DEPLOYMENT.md`).

`fly.production.toml` `[[http_service.checks]]`: `GET /api/health`, 15s
interval, 10s grace period, 5s timeout — identical to staging.

## Database

- **Fly Managed Postgres** (`fly mpg`), cluster `stones4u-cc-production-db`, region `ams`, **plan Basic** (shared×2 CPU, 1GB RAM, 10GB disk, $38/mo).
- **Why Basic and not a larger plan**: this is an internal staff tool (small user count, no public traffic), the same class of workload `docs/build/PHASE-1-PRODUCTION-READINESS.md` §8 already sized for a single `shared-cpu-1x`/512MB app machine, and Basic already includes automatic backups (verified — see "Backup / recovery" below). Upgrading later (`fly mpg` supports plan changes) is straightforward if real usage ever demands it; provisioning a Launch/Scale/Performance-tier cluster ($282–$1,922/mo) upfront for a handful of internal users would be paying for capacity with no corresponding need.
- Attached via `fly mpg attach <cluster-id> --app stones4u-control-center --variable-name DATABASE_URL` — the connection string is set directly as a Fly secret, never typed manually.
- **Exclusive to this app.** Not shared with staging, OfferteApp, POS, TelefoonSysteem, or any other Stones4U system.

### Backup / recovery

- Fly Managed Postgres runs **automatic backups on every plan, including Basic** — verified empirically (not just from documentation) by checking `fly mpg backup list <cluster-id>` immediately after cluster creation: a full backup completed automatically within seconds, with an incremental backup following.
- **Restore**: `fly mpg restore <cluster-id> --backup-id <id>` (restore from a specific backup) or `fly mpg restore <cluster-id> --pitr-time <RFC3339 timestamp>` (point-in-time recovery, if the target time falls inside the cluster's PITR window). Restoring **always creates a new cluster** — the source cluster is left unchanged, so a restore is never destructive to the live production database. Re-attach the app to the restored cluster (or repoint `DATABASE_URL`) once verified.
- **Retention / exact PITR window**: not stated in a single authoritative number by Fly's public docs at the time of this deployment; verify current retention via `fly mpg backup list <cluster-id>` (shows actual available backup points) before relying on a specific RPO figure. Treat the practical RPO as "at most the interval between the incremental backups observed in that list" until confirmed otherwise.
- List current backups: `fly mpg backup list stones4u-cc-production-db` (or the cluster ID).

## Migration strategy

`fly.production.toml`:
```toml
[deploy]
  release_command = "npx prisma migrate deploy"
```
Runs once, on its own one-off machine, before any `app` machine starts or updates — a migration failure blocks the entire deploy (verified live on this first deploy — see "First deploy" below). Never `prisma migrate dev` or `prisma db push` against this database.

Check migration status before/after a deploy:
```
fly mpg proxy <cluster-id>              # tunnels the cluster to localhost
# then, from another terminal, with a local psql/prisma pointed at the tunnel:
npx prisma migrate status
```

## Environment variables (names only)

| Variable | Set via | Notes |
|---|---|---|
| `DATABASE_URL` | Fly secret (via `fly mpg attach`) | Production's own Managed Postgres cluster |
| `SESSION_SECRET` | Fly secret (`openssl rand -hex 32`, generated fresh for production — independently of staging's value) | HMAC pepper for session tokens |
| `SHOPIFY_SHOP_DOMAIN` / `_CLIENT_ID` / `_CLIENT_SECRET` / `_API_VERSION` / `_EXPECTED_MYSHOPIFY_DOMAIN` | Fly secrets | Same real Stones4U shop as staging/local dev — there is only one |
| `APP_ENV` | `fly.production.toml` `[env]` (plain, non-secret) | `production` |
| `NODE_ENV` | `Dockerfile` `ENV` (baked into the image) | `production` |
| `TELEFOONSYSTEEM_*`, `EXACT_HISTORY_*` | **Not set** | Adapters stay disabled by design (ADR-004) |

```
fly secrets list --app stones4u-control-center   # names + digests only, never values
```

## Bootstrap admin

**Not automated — by explicit design.** Exactly like staging, and per this
deployment's own instruction that the admin password must be chosen by a
human, never generated or seen by Claude:

```
fly ssh console --app stones4u-control-center
BOOTSTRAP_ADMIN_EMAIL="you@stones4u.eu" BOOTSTRAP_ADMIN_PASSWORD="<a-strong-password-you-choose>" BOOTSTRAP_ADMIN_NAME="Your Name" npm run bootstrap:admin
exit
```

- Refuses unconditionally if any `User` row already exists (verified in the staging dry run; the production database starts empty, so this will succeed exactly once).
- No default/placeholder password exists anywhere in the codebase.
- No public registration endpoint exists.
- Log in once at `https://stones4u-control-center.fly.dev/login` to confirm, then change the password via `/settings` if desired.

## Deploy

```
fly deploy --app stones4u-control-center -c fly.production.toml
```

Always pass `-c fly.production.toml` explicitly — without it, `fly deploy` falls back to `fly.toml` (staging's config) and would attempt to deploy staging's app name/settings instead.

## Smoke tests (repeat after every deploy)

```
curl -s https://stones4u-control-center.fly.dev/api/health                    # expect {"status":"ok"}
curl -s -o /dev/null -w "%{http_code}\n" .../login                            # expect 200
curl -s -o /dev/null -w "%{http_code}\n" .../                                 # expect 307
curl -s -o /dev/null -w "%{http_code}\n" -X POST .../api/auth/login \
  -H "Content-Type: application/json" -d '{"email":"x","password":"wrong"}'   # expect 401
curl -s -o /dev/null -w "%{http_code}\n" .../api/admin/users                  # expect 401 unauthenticated
fly status --app stones4u-control-center                                      # both machines "started", checks passing
```

Then, authenticated (after bootstrap): full login → customer search (real Shopify data) → Customer 360 → orders → a multi-line test note (verify line breaks render correctly — see the rich-text fix in `docs/build/PHASE-1-STAGING-DEPLOYMENT.md`'s referenced commit) → edit/delete it → a test task (assign to self, complete, verify persistence on refresh) → activity timeline ordering → admin users page (confirm only the real admin exists) → VIEWER negative-permission checks → a full visual pass watching for console/hydration errors.

## Logs

```
fly logs --app stones4u-control-center
```

Reviewed after every deploy for: no password, no `SESSION_SECRET`, no Shopify client secret/access token, no full session token, no full `DATABASE_URL` — the Prisma migration log line prints only the datasource **hostname**, never the credential.

## Rollback

**App:**
1. `fly releases --app stones4u-control-center` — find the previous working release.
2. `fly deploy --app stones4u-control-center -c fly.production.toml --image <previous-image-ref>` (or `fly releases rollback` if available).

**Database:**
- Migrations are forward-only. There is exactly one migration (`20260901211016_init`), purely additive (new tables/enums only) — rolling back to any earlier app release works unmodified against a database that has since gained these tables.
- No destructive rollback is ever run automatically. If a restore is genuinely needed: `fly mpg restore <cluster-id> --backup-id <id>` or `--pitr-time <timestamp>` — always creates a **new** cluster, source is untouched; re-point `DATABASE_URL` only after verifying the restored data.

## Not yet configured (by explicit instruction)

- No custom domain (`crm.stones4u.eu`, `control.stones4u.eu`, or otherwise) — only the standard `fly.dev` URL, until staging→production is fully verified end-to-end through the UI.
- No DNS changes of any kind.
