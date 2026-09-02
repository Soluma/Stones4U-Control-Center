@AGENTS.md

# Claude instructions — Stones4U Control Center

This repository is the **Stones4U Control Center** — the new, central internal
platform for Stones4U (CRM, Tasks, Customer 360, and eventually Sales/
Operations/Service). Full architectural context lives in
`docs/architecture/ADR-001` through `ADR-006` and
`docs/platform-discovery/24-UNIFIED-CONTROL-CENTER-TARGET.md` /
`25-PHASE-1-BUILD-SPEC.md` — read those before making structural changes.

## Ownership

This repo owns: `User`, `Session`, `CustomerProfile`, `Note`, `Task`,
`Activity`, `AuditEvent` (see `prisma/schema.prisma`), the Control Center web
app and API, and the Shopify client-credentials adapter used by Control
Center itself.

## Sibling apps are read-only, always

The following repositories are **siblings**, not part of this codebase:

- `../OfferteApp` (Flask — internal quotes/orders/sales)
- `../s4u-quote-app` (Remix — storefront quote requests)
- `../Kassa Systeem` (Next.js — POS)
- `../TelefoonSysteem` (Node/Turborepo — telephony, call/contact/task data)

**Never edit code in any of these from a Control Center task, even if it
would be the "easy fix."** They are independent, separately-deployed
production applications (see `docs/platform-discovery/01`–`23` for what they
each own). If a change to one of them is genuinely required, that is a
separate, explicitly-scoped task in that repository — not something to do
"while you're at it" here. Cross-repo changes always need an explicit
instruction naming that repository.

Analyzing their code (read-only, to understand business rules or data
shapes) is encouraged and already how this repo's design was informed — see
`docs/platform-discovery/21-TASKS-NOTES-REUSE-ANALYSIS.md` for exactly what
was reused as *reference* vs. what was deliberately reimplemented
(`docs/architecture/ADR-003`).

## Module boundaries within this repo

- `src/platform/*` — auth, db, audit, security. Generic, no business logic.
  Every module depends on this; this never depends on a module.
- `src/integrations/*` — one folder per external system (`shopify`,
  `telephony`, `exact`, `quotes`), each behind a small adapter interface.
  `telephony` and `exact` are **intentionally disabled** in Phase 1 (see
  their own file comments and
  `docs/build/PHASE-1-IMPLEMENTATION-REPORT.md`) — do not "fix" this by
  wiring up TelefoonSysteem's human-login JWT as a pseudo-service-credential;
  that was explicitly rejected. A real fix requires a new service-auth
  mechanism on TelefoonSysteem's side, out of scope here.
- `src/modules/*` — business logic (`crm`, `tasks`, `activity`, `admin`).
  May depend on `platform` and `integrations`, never the reverse.
- `src/app/*` — Next.js routes (pages + API). Thin — delegates to `modules`.

## Shopify identity principle (ADR-002)

Shopify remains the commercial source of truth for customer identity (name,
email, phone, addresses, orders). `CustomerProfile` never duplicates that —
it only carries CRM-specific fields (`crmStatus`, `accountManagerId`,
`tags`) plus a **denormalized snapshot** refreshed on read, keyed by the
unique `shopifyCustomerGid`. Never add a field to `CustomerProfile` that
should instead be read live from Shopify.

## Task/Note ownership (ADR-003)

`Task` and `Note` are centrally owned here — not proxied from
TelefoonSysteem. Do not add a "sync" job that copies TelefoonSysteem's
`Task`/`ContactNote` rows into this database; the two are deliberately
separate, and TelefoonSysteem's data is projected into the Activity Timeline
live (see `src/modules/activity/timeline.ts`), never persisted here.

## Shopify writes

Phase 1 is **read-only against Shopify** (`src/integrations/shopify/`
exposes no mutation helpers). Before adding any Shopify write in a later
phase: use `assertShopifyShopIdentity()` from
`src/integrations/shopify/guard.ts` first, every time, no exceptions — this
mirrors the safety pattern already proven in Kassa Systeem.

## No big-bang migration

Never write code in this repo that reads or writes another app's database
directly, assumes a shared connection string, or requires a coordinated
deploy with another app. Every integration goes through an HTTP adapter
(`src/integrations/*`) that fails gracefully when the other system is
unavailable — see `docs/architecture/ADR-004`.

## Before making changes

- Run `npm run typecheck && npm run lint && npm run test` — all three must
  stay green.
- `npm run build` uses Turbopack (`next build --turbopack`) — see
  `next.config.ts` for why the plain webpack build path is avoided on this
  machine.
- Do not weaken `src/platform/auth/guards.ts` checks or remove audit calls
  (`src/platform/audit/audit.ts`) from an existing mutation without being
  explicitly asked to.
