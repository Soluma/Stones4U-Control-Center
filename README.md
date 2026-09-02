# Stones4U Control Center

The new, central internal platform for Stones4U — CRM, Tasks, and Customer 360
today; Sales, Operations, Service, and deeper Telephony/POS integration in
later phases. See `docs/architecture/ADR-001` through `ADR-006` and
`docs/platform-discovery/24-UNIFIED-CONTROL-CENTER-TARGET.md` for the full
architectural rationale, and
`docs/build/PHASE-1-IMPLEMENTATION-REPORT.md` for what this specific build
delivered.

## What Phase 1 is (and isn't)

**Is**: a working, tested Next.js/Prisma/PostgreSQL app with its own login
(argon2 + DB-backed sessions), a Customer 360 page backed by live Shopify
data (client-credentials, read-only), and centrally-owned Notes and Tasks
with a unified Activity Timeline. See `docs/platform-discovery/25-PHASE-1-BUILD-SPEC.md`.

**Isn't**: a replacement for POS, OfferteApp, s4u-quote-app, or
TelefoonSysteem — none of those are touched by this repository. Isn't a
telephony or Exact-invoice integration either — see
"TelefoonSysteem & Exact adapters" below.

## Stack

Next.js 15 (App Router, Turbopack), React 19, TypeScript (strict), Prisma 6,
PostgreSQL. Chosen to match the stack already proven in this landscape (Kassa
Systeem, TelefoonSysteem's `apps/web`/`apps/api`) rather than introducing a
new one — see `docs/platform-discovery/24` "Technische architectuur".

## Local setup

1. **Node.js 22+** and npm (no pnpm/yarn required).
2. **PostgreSQL**, any of:
   - Docker: `docker run -d --name crm-postgres -e POSTGRES_USER=crm -e POSTGRES_PASSWORD=<your-choice> -e POSTGRES_DB=stones4u_control_center -p 55432:5432 postgres:16-alpine`
   - Or a Fly Postgres instance reached via `fly proxy`, matching every other app in this landscape.
3. Copy `.env.example` to both `.env` (read by the Prisma CLI) and `.env.local`
   (read by Next.js at runtime) and fill in `DATABASE_URL` and `SESSION_SECRET`
   at minimum. Leave the `SHOPIFY_*`/`TELEFOONSYSTEEM_*`/`EXACT_*` vars empty
   to run with those integrations gracefully disabled (see below).
4. `npm install`
5. `npm run prisma:migrate` — applies the schema to your database.
6. Create the first admin account (never via a committed credential):
   ```
   BOOTSTRAP_ADMIN_EMAIL=you@stones4u.eu BOOTSTRAP_ADMIN_PASSWORD=<a-strong-password> npm run bootstrap:admin
   ```
   This refuses to run if any `User` already exists (see `scripts/bootstrap-admin.ts`).
7. `npm run dev` and log in at `http://localhost:3000/login`.

## Environment variables (names only — see `.env.example`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Session token signing/hashing |
| `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_API_VERSION`, `SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN` | Shopify client-credentials adapter (ADR-006) — create a custom app in Shopify Admin with client-credentials enabled |
| `TELEFOONSYSTEEM_API_BASE_URL`, `TELEFOONSYSTEEM_SERVICE_TOKEN` | Reserved for the TelefoonSysteem adapter — **not usable yet**, see below |
| `EXACT_HISTORY_API_BASE_URL`, `EXACT_HISTORY_SERVICE_TOKEN` | Reserved for the Exact-history adapter — **not usable yet**, see below |

## Shopify setup

Phase 1 needs its own Shopify **custom app with client-credentials access**
(Shopify Admin → Settings → Apps and sales channels → Develop apps). Required
scopes for Phase 1 (read-only): `read_customers`, `read_orders`,
`read_draft_orders`. Without this configured, the app runs fine — customer
search returns a clear "not configured" message (HTTP 503) instead of
crashing.

## TelefoonSysteem & Exact adapters — intentionally disabled

`src/integrations/telephony/adapter.ts` and `src/integrations/exact/adapter.ts`
are real interfaces wired to disabled implementations, **not stubs waiting to
be filled in with a quick fix**. TelefoonSysteem has no service-to-service
credential today — the only way to call its API is a human login, and this
build was explicitly instructed not to use a human account as a pseudo-service-
credential. Enabling these requires a small, separate change to
TelefoonSysteem itself (extending its existing `INTERNAL_SECRET` pattern) —
out of scope for this repository. See
`docs/build/PHASE-1-IMPLEMENTATION-REPORT.md` for the full explanation.

## Commands

```
npm run dev              # start the dev server (Turbopack)
npm run build             # production build (Turbopack — see next.config.ts)
npm run start              # run the production build
npm run lint                # eslint
npm run typecheck            # tsc --noEmit
npm run test                  # vitest (unit + integration against DATABASE_URL)
npm run prisma:migrate         # apply schema changes locally
npm run prisma:studio           # browse the database
npm run bootstrap:admin          # create the first ADMIN account
```

## Project structure

```
src/
  app/                 Next.js routes — (app)/ is the authenticated shell, api/ the backend
  platform/            auth, db, audit, security — generic, no business logic
  integrations/        one folder per external system, each behind an adapter interface
    shopify/           client-credentials Shopify Admin GraphQL client (read-only, Phase 1)
    telephony/          TelefoonSysteem adapter — disabled (see above)
    exact/               Exact-history adapter — disabled (see above)
    quotes/               OfferteApp/s4u-quote-app adapter — disabled, no read API exists yet
  modules/              business logic: crm (CustomerProfile, Note), tasks, activity, admin
  components/            ui/ (design system primitives) and layout/ (shell, nav, command palette)
prisma/                 schema.prisma + migrations
tests/                   vitest unit + integration tests
scripts/                  bootstrap-admin.ts
docs/                      architecture/ (ADRs) — this repo's own docs, plus the inherited
                            platform-discovery/ set from the wider Stones4U platform effort
```
