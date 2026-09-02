# Phase 1 Implementation Report — Stones4U Control Center

Built 2026-09-01/02, following `docs/architecture/ADR-001`–`ADR-006` and
`docs/platform-discovery/25-PHASE-1-BUILD-SPEC.md`. Every item below was
verified running, not just written — see "Verification performed" for the
exact commands and their output.

## 1. Pre-flight findings (Fase A)

| Check | Result |
|---|---|
| `CRM/` directory | Empty except `docs/` — safe to build in. No git repo existed; initialized (`git init -b main`), no commits made without being asked. |
| Node.js | v22.11.0 — used as-is. |
| Package manager | npm 10.9.0 (no pnpm/yarn installed) — used npm, matching Kassa Systeem's choice. |
| PostgreSQL | No local server/client installed. **Provisioned**: a local Docker Postgres container (`postgres:16-alpine`, port 55432, isolated to this project) since Docker Desktop was installed but not running — started it, waited for the daemon, then ran the container. This is a local dev database only; production deployment should use Fly Postgres (matching every other app in the landscape, see `docs/platform-discovery/04-INFRASTRUCTURE-MAP.md`) or Neon. |
| Fly.io CLI | Installed and authenticated (`stones4unl@gmail.com`) — not used; Phase 1 deploys nothing. |
| Shopify access | **No client-credentials custom app exists yet for Control Center.** No `.env` file, no environment variable, existed anywhere for this. This is not a "Shopify is down" situation — it requires a person to create a custom app in Shopify Admin (Settings → Apps and sales channels → Develop apps) with client-credentials enabled and `read_customers`/`read_orders`/`read_draft_orders` scopes, then set `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`/`SHOPIFY_SHOP_DOMAIN`/`SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN`. Per the build instructions, this did **not** block Phase 1: the full Shopify client (token cache, GraphQL transport, retry, error typing) was built and unit-tested against a mocked Shopify API; `isShopifyConfigured()` makes every dependent route degrade to a clear "not configured" (HTTP 503) response instead of crashing when the real credentials aren't present yet — verified live (see §7). |
| TelefoonSysteem read-only integration | **Not safely possible today without modifying TelefoonSysteem.** Investigated its API (`docs/platform-discovery/19` §4, `22`): every route requires a human-oriented JWT login (email+password → 7-day bearer token), with no service-account or scoped machine credential concept. The only way to call it would be to log in as a dedicated human "VIEWER" account and store that account's password server-side as a pseudo-service-credential — explicitly the "onveilige workaround" this build was told to stop short of. **Per instruction, this did not block Phase 1**: `TelephonyAdapter`/`ExactHistoryAdapter` interfaces were built with `Disabled*` implementations wired in by default, documented in-code and here. TelefoonSysteem itself was not modified, called, or logged into anywhere in this codebase — verified by inspection (no HTTP client, no credential handling for TelefoonSysteem exists in `src/integrations/telephony/` or `exact/`, only in their own doc comments). |

## 2. What was built

### Platform foundation (Fase B, C)
- Next.js 15 (App Router) + TypeScript strict + Prisma 6 + PostgreSQL, `src/{app,platform,integrations,modules,components,lib}` module layout (matches the brief's suggested structure closely; see "Deviations" below for the one change).
- Auth: `User`/`Session`/`Role` (`ADMIN`/`AGENT`/`VIEWER`), argon2id password hashing, DB-backed sessions (httpOnly/secure/sameSite=lax cookies, SHA-256-hashed token at rest, revocable — deliberately not TelefoonSysteem's stateless-JWT approach), role guards (`requireUser`/`requireWriteAccess`/`requireAdmin`), audited login/logout/failed-login, rate-limited login (8 attempts/5min/IP — none of the three existing Stones4U auth systems have this).
- Bootstrap: `scripts/bootstrap-admin.ts`, env-var-only credentials, refuses if any `User` row exists — verified working (§7) and refuses on a second run.

### Central data model (Fase D)
`User`, `Session`, `CustomerProfile`, `Note`, `Task`, `Activity`, `AuditEvent`, plus a schema-only, unused-in-Phase-1 `File` model (ADR-005) — see `prisma/schema.prisma`, migration `20260901211016_init`, applied and verified against the local Postgres.

`CustomerProfile.shopifyCustomerGid` is `@unique` — the dedup guarantee is enforced by the database, not just application logic; covered by an integration test that fires three concurrent `getOrCreateCustomerProfile()` calls for the same GID and asserts exactly one row exists.

### Shopify adapter (Fase E)
`src/integrations/shopify/` — client-credentials grant (never a static admin token), in-memory token cache with expiry buffer and in-flight de-duplication (ported from Kassa Systeem's proven pattern), GraphQL transport with 2 retries on transient (5xx/429/network) errors only (improves on Kassa Systeem's no-retry client; a real bug in the first draft — treating any error without an HTTP status as "transient," which misclassified GraphQL-level user errors — was caught by the test suite and fixed, see `src/integrations/shopify/client.ts` comments), `assertShopifyShopIdentity()` guard (ready for Phase 2+ writes, unused by any Phase 1 code path since Phase 1 has none), typed `ShopifyApiError`/`ShopifyConfigError`. Read-only: customer search, customer-by-GID, order history with financial/fulfillment status and totals. **No mutation function exists anywhere in this module.**

### Customer search & Customer 360 (Fase F, G)
`/customers` — debounced Shopify search, keyboard navigation (arrow keys + Enter), loading/empty/error states. Opening a result calls `/api/customers/resolve`, which lazily upserts the `CustomerProfile` (dedup guaranteed as above) and redirects to `/customers/[id]`.

`/customers/[id]` — header (name, company, email, phone, address, order count, total spent, outstanding-order count, last order date, editable CRM status), tabs (Overzicht/Orders/Activiteit/Notities/Taken). A Shopify fetch failure shows a clear error state without crashing the rest of the page; the Activity tab shows a transparent "not yet connected" notice for the disabled telephony/Exact adapters rather than silently omitting them.

### Notes (Fase H)
`src/modules/crm/note.service.ts` + `src/platform/security/rich-text.ts`. Real structured rich text was implemented (not deferred): a small closed JSON node tree (paragraphs, bullet lists, bold/italic/code marks, links), parsed from a lightweight markdown-like plain-text input and rendered via `RichTextView.tsx` with **no `dangerouslySetInnerHTML` anywhere in the codebase** — verified by grep. Every note is editable and soft-deletable (`deletedAt`), unlike every existing Note implementation found in discovery (all three were append-only). Every create/update/delete writes both an `Activity` row and an `AuditEvent`.

### Tasks (Fase I)
`src/modules/tasks/task.service.ts`. Creator/assignee/admin authorization (referenced from, not copied from, TelefoonSysteem's proven pattern — `docs/architecture/ADR-003`), full status lifecycle, `dueAt`/overdue computation, task creation from Customer 360, personal task list with `mine`/`assigned`/`created`/`overdue`(/`all` for admins) filters, dashboard summary widget. Relations to `Order`/`Quote`/`Call`/`Supplier`/`PurchaseOrder`/`ProductionJob`/`Complaint` exist as schema fields (per the brief) but are deliberately unused by any Phase 1 business logic.

### Activity Timeline (Fase J)
`src/modules/activity/timeline.ts` — merges Control-Center-owned `Activity` rows with live-projected Shopify orders (never persisted) and the (currently empty, since disabled) telephony/Exact adapter results into one chronologically-sorted list. A Shopify order is visible in the timeline in Phase 1, as required — verified by the `SHOPIFY_ORDER` activity type mapping in `getCustomerTimeline()`.

### Telephony & Exact adapters (Fase K, L)
Interfaces + `Disabled*` implementations, as directed. See §1 and the in-file comments in `src/integrations/telephony/adapter.ts` and `src/integrations/exact/adapter.ts` for exactly what would be needed to enable them (a new TelefoonSysteem-side service credential). `src/integrations/quotes/adapter.ts` was added on the same pattern for OfferteApp/s4u-quote-app, which have no read API at all (not even a human-login one) — consistent with the brief's own module-folder example (`integrations/quotes/`).

### GUI (Fase M)
Tailwind-based design system (`tailwind.config.ts` — neutral canvas/surface/border/ink scale, one accent color, restrained shadows) aiming at the Linear/Stripe/Shopify-Admin register: generous whitespace, subtle borders, tabular numerals on metrics, skeleton loading states, explicit empty states with guidance text (never a bare blank screen), inline Badge components for status. Full navigation tree as specified (Dashboard/CRM/Sales/Operations/Service/Beheer), with not-yet-built destinations rendered as visibly disabled "Binnenkort" rows rather than dead links or fake-functional pages.

### Command search (Fase N)
`Ctrl/Cmd+K` global overlay (`CommandPalette.tsx`) plus a `/search`-backed API returning typed result **groups** — Phase 1 populates only a `customers` group, but the response shape and UI already support adding `orders`/`quotes`/`products`/`suppliers`/`tasks`/`production_jobs` groups later without a rework.

### Audit & security (Fase O)
Every mutating action (login/login-failed/logout, note create/update/delete, task create/status-change/assign/complete/cancel, customer-profile CRM-field changes, user create/role-change/deactivate) writes an `AuditEvent` via one central `logAudit()` — verified to never throw even when the write itself fails (foreign-key violation in the test), matching the "must never break the caller" principle from OfferteApp's `log_audit()`. No secret or token value is ever logged (verified by reading every `console.error`/`logAudit` call site).

### Tests (Fase P)
31 tests across 9 files, **all passing**: `phone.test.ts` (Dutch phone normalization — the exact bug class found in TelefoonSysteem, `docs/platform-discovery/22`), `rich-text.test.ts` (parsing + schema rejection of a malformed/HTML-injection-shaped doc), `password.test.ts` (argon2 hash/verify, malformed-hash safety, strength check), `shopify-client.test.ts` (config validation, token caching/reuse, retry-on-transient, no-retry-on-GraphQL-user-error — this test caught the transient-error misclassification bug described above), `customer-profile.test.ts` (dedup guarantee, integration against the real local DB), `notes.test.ts`, `tasks.test.ts` (including the permission-denial paths), `audit.test.ts`, `adapters.test.ts` (every disabled adapter fails safe — never throws, always returns an empty/null result).

### Documentation (Fase Q)
`README.md` (setup, env vars, commands, structure), `CLAUDE.md` + `AGENTS.md` (ownership, sibling-repo boundaries, module boundaries, Shopify/Task-Note principles, no-big-bang rule) — see those files for the full content, not duplicated here.

## 3. Architecture choices / deviations from the brief

- **Folder structure**: used `src/modules/{crm,tasks,activity,admin}` and `src/integrations/{shopify,telephony,exact,quotes}` instead of the brief's `src/modules/{crm,tasks,activity,customers}` / `src/integrations/{shopify,telephony,exact,quotes}`. Customer logic lives in `modules/crm/customer-profile.service.ts` rather than a separate `modules/customers/` — it was small enough that a dedicated module would have been a premature split; can be extracted later if it grows (e.g. once Files/Appointments attach to it in Phase 2).
- **Rich text was implemented directly** (not deferred) since a small closed-schema approach was genuinely low-complexity and meaningfully better than plain text for the CRM-notes acceptance bar.
- **Next.js build uses Turbopack**, not the default webpack path — see `next.config.ts` for the exact, verified reason (a Windows-specific EPERM in webpack's build tracer, unrelated to this project's code, confirmed by reproducing it with both `output: "standalone"` and Next's built-in lint step independently disabled — neither fixed it — while switching to `--turbopack` fixed it immediately with a clean, fully-typed, fully-generated build).
- **`output: "standalone"`** (needed for the eventual Docker/Fly.io deploy) is currently **off** because it triggers the same tracer issue. This needs to be revisited on the actual deployment machine (likely a non-issue on Linux/Fly) before shipping a container image — tracked below under "Known limitations."

## 4. Migrations

One migration: `prisma/migrations/20260901211016_init/migration.sql` — creates every Phase 1 table (`User`, `Session`, `CustomerProfile`, `Note`, `Task`, `Activity`, `AuditEvent`, `File`) and enum. Applied and verified against a local Postgres. **No data migration of any kind** — Phase 1 starts with an empty database (plus the bootstrapped first admin) and reads Shopify/TelefoonSysteem/Exact live, per `docs/platform-discovery/25-PHASE-1-BUILD-SPEC.md` §15.

## 5. Verification performed (not claimed — run)

```
npm run typecheck   → clean, zero errors
npm run lint         → clean, zero errors/warnings
npm run test          → 9 files, 31 tests, all passing
npm run build           → succeeds (Turbopack), all 24 routes compile and type-check
```

Live smoke test against `npm run dev` (local Postgres, no Shopify credentials configured):
- `GET /api/health` → `{"status":"ok"}`
- `GET /login` → 200; `GET /` unauthenticated → 307 to `/login`
- `POST /api/auth/login` with the bootstrapped admin → sets session cookie, returns user
- `GET /` authenticated → 200
- `GET /api/tasks/summary` authenticated → `{"assignedToMe":0,"createdByMe":0,"overdue":0,"dueToday":0}`
- `GET /api/admin/users` authenticated as ADMIN → returns the one bootstrapped user
- `GET /api/customers/search?q=test` with no Shopify credentials configured → HTTP 503 with a clear Dutch error message, **not a crash**
- `GET /customers`, `/tasks`, `/admin/users` → all 200
- `POST /api/auth/logout` → `GET /` afterward → 307 (session correctly revoked)

## 6. Routes (for reference, no screenshots — terminal-only environment)

| Route | What it shows |
|---|---|
| `/login` | Email/password form, rate-limited, redirects to `/` on success |
| `/` | Dashboard: task summary tiles (assigned/created/overdue/due-today), quick links |
| `/customers` | Debounced Shopify search with keyboard nav, empty/loading/error states |
| `/customers/[id]` | Customer 360 — header with editable CRM status + metrics, 5 tabs |
| `/tasks` | Filterable task list (mine/assigned/created/overdue/all-for-admins) |
| `/admin/users` | ADMIN-only: user list, create user, change role, deactivate |
| `/settings` | Change own password |

## 7. Known limitations

1. **Shopify credentials not yet provisioned** — Control Center needs its own custom app (client-credentials) created in Shopify Admin; see README "Shopify setup". Everything downstream of that (search, Customer 360, orders, timeline) is built and tested but cannot be exercised against the real store until this exists.
2. **TelefoonSysteem and Exact adapters are disabled by design** — see §1. Fixing this requires a small, separate change to TelefoonSysteem (a service-auth credential), out of scope for this repo.
3. **OfferteApp/s4u-quote-app have no read API at all** — the `quotes` adapter is a prepared interface with no working implementation possible yet (Phase 7/8 work per `docs/platform-discovery/24`).
4. **`output: "standalone"` is disabled** — needs revisiting on the actual deploy target before a container image can be built; likely a non-issue on Linux, unconfirmed.
5. **npm audit reports 11 vulnerabilities** (3 moderate, 6 high, 2 critical) in transitive dev/build dependencies (not runtime application code) — typical for a fresh Next.js project's dependency tree; not investigated further in Phase 1, worth a `npm audit` pass before production deploy.
6. **No CI pipeline** — `typecheck`/`lint`/`test`/`build` were run manually and are documented as green; wiring them into GitHub Actions (or equivalent) is a reasonable Phase 2 addition, not done here.
7. **Command search covers customers only** — by design (`docs/platform-discovery/25` §Command Search), extensible per the group-based response shape already in place.
8. **No password-reset flow** — only "change your own password while logged in" (`/settings`) and admin-created accounts exist; a forgot-password flow was out of Phase 1 scope and not requested.

## 8. Deployment readiness

**Not deployed, and this report does not recommend deploying yet.** Before a first deploy:
- Provision a Fly Postgres (or Neon) database and a Fly app, per the pattern in `docs/platform-discovery/04-INFRASTRUCTURE-MAP.md`.
- Create the Shopify custom app and set its credentials as Fly secrets (names only, per this whole project's convention — never commit values).
- Resolve `output: "standalone"` for a container build (§7.4).
- Run `npm run bootstrap:admin` once against the production database via `fly ssh console` (mirroring OfferteApp's own bootstrap pattern) rather than any committed credential.
- Add a `Dockerfile` and `fly.toml` (not created in this pass — not requested, and doing so without being able to verify the container build on this machine would be guesswork).

## 9. Exact remaining manual steps

1. Create a Shopify custom app (client-credentials) and set `SHOPIFY_*` env vars.
2. Decide and implement a TelefoonSysteem service-auth mechanism (TelefoonSysteem-side change, separate task) before enabling `src/integrations/telephony/adapter.ts`.
3. Same for Exact (`src/integrations/exact/adapter.ts`), likely via the same TelefoonSysteem-side mechanism since it's the only existing read path.
4. Decide a production database host (Fly Postgres vs. Neon) and provision it.
5. Resolve the `output: "standalone"` tracer issue on the target deploy OS, or confirm it doesn't reproduce on Linux.
6. Write a `Dockerfile`/`fly.toml` once the above is settled (not part of this Phase 1 pass).
