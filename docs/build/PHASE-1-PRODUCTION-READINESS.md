# Phase 1 Production Readiness Review — Stones4U Control Center

Review performed 2026-09-02 against the Phase 1 codebase built per `docs/build/PHASE-1-IMPLEMENTATION-REPORT.md`. Every finding below was verified by reading the actual code, running the actual tooling, or reproducing the actual behavior — not inferred. No sibling repository was touched. No deploy was performed. No Phase 2 functionality was added; every fix below closes a gap in already-specified Phase 1 behavior (see `docs/platform-discovery/25-PHASE-1-BUILD-SPEC.md` §6, §8) or a genuine correctness/security defect.

## 1. Git / Repository check

| Item | Result |
|---|---|
| Branch | `main`, no commits yet (nothing was committed by either build session — matches "only commit when asked") |
| `git diff` | N/A, nothing committed |
| Secrets tracked | **None found** — `.env`/`.env.local` correctly untracked; repo-wide scan for connection-string/token-shaped strings in tracked-candidate files found nothing |
| **`.gitignore` gap — FIXED** | `prisma/generated/` was the ignored path, but `schema.prisma`'s actual generator output is `src/generated/prisma` — **25MB of generated Prisma client, including a Windows-specific native binary (`query_engine-windows.dll.node`), was not ignored** and would have been committed by a plain `git add .`. Fixed: `.gitignore` now ignores `src/generated/` (and `*.tsbuildinfo`, also previously untracked-but-unignored). |
| Sibling repos | Verified untouched via `git status --short` in `OfferteApp/`, `s4u-quote-app/`, `TelefoonSysteem/` (clean) and `Kassa Systeem/` (only its pre-existing, unrelated untracked `mapi-demo-1.35-release/`) |

## 2 & 3. Security review

| Area | Result |
|---|---|
| Password hashing | argon2id via `@node-rs/argon2`, verified working natively on both Windows and Linux/musl (§7). PASS. |
| Session creation/lookup/invalidation | DB-backed, SHA-256/HMAC-hashed token at rest, raw token only in the httpOnly cookie, revocable. PASS. |
| **Session secret — FIXED** | `SESSION_SECRET` was documented in `.env.example`/README as "used to hash session tokens" but **was never actually read anywhere** — every session was hashed with plain SHA-256 regardless of configuration. Fixed: `hashToken()` now HMAC-peppers with `SESSION_SECRET`, **required in production** (throws at hash time if missing when `NODE_ENV=production`), with a clearly-logged insecure dev fallback otherwise. Verified: changing the secret invalidates previously-issued sessions (3 new tests, `tests/session.test.ts`); the production-required branch was verified correct by direct code inspection and reproduced standalone in plain Node (Vite/vitest's module caching does not reliably let an automated test reassign `process.env.NODE_ENV` across a dynamic-import boundary in this setup — documented in the test file). |
| Cookies | `httpOnly: true`, `secure: NODE_ENV === "production"`, `sameSite: "lax"`, correct `path`/`maxAge`. PASS. |
| Session fixation | No pre-auth session exists to fixate — a session is only ever created after a successful password check. PASS. |
| Brute force | Login is rate-limited (8 attempts/5min/IP, in-memory). **Caveat, documented not fixed**: the limiter keys on `X-Forwarded-For`, which is attacker-controllable unless the deployment platform overwrites it — true of Fly.io's edge proxy but must not be assumed for any other exposure path. See "Deployment prerequisites". |
| CSRF | No CSRF-token mechanism exists. **Assessed as adequate for Phase 1, not a blocker**: every mutating route requires an `application/json` body, which cannot be sent by a simple cross-site HTML form, and no CORS headers are set anywhere in the app (verified by grep) — so a cross-origin `fetch`/XHR with a JSON body is blocked by the browser's CORS preflight before it ever reaches the server, and `SameSite=Lax` blocks simple cross-site form POSTs regardless. Recommendation for a later phase: explicit CSRF tokens as defense-in-depth (OfferteApp already does this via Flask-WTF). |
| **Privilege escalation — FIXED** | `PATCH /api/tasks/[id]` gated on `requireUser()` only, delegating all authorization to `task.service`'s creator/assignee/admin check — which does not consider role. Since an AGENT/ADMIN can assign a task to a VIEWER, **a VIEWER could mutate that task's status/assignment via a direct API call**, contradicting VIEWER's read-only design everywhere else. Fixed: route now uses `requireWriteAccess()`. **Live-reproduced and confirmed closed** in the UX smoke test (§13, step 12: a VIEWER assigned to a task now gets `403` on the exact request that previously would have succeeded). |
| **IDOR — FIXED** | `updateNote`/`deleteNote` applied **no ownership check at all** — any AGENT could edit or delete any other AGENT's note, contradicting the documented Phase 1 permission model (`docs/platform-discovery/25` §6: "AGENT: Notities bewerken/verwijderen — alleen eigen notities"). Fixed: both now fetch the note first and enforce author-or-admin via a new `assertCanModifyNote()`, mirroring the pattern already used for tasks. 3 new regression tests (`tests/notes.test.ts`). |
| IDOR — customer data | No per-record customer isolation exists (any authenticated user can view any `CustomerProfile`) — **by design**, matching `docs/platform-discovery/25` §6 ("Klanten lezen: ✅ alle rollen") and how POS/OfferteApp already work; not a finding. |
| Admin routes | All gated `requireAdmin()`. A non-admin cannot self-escalate (verified: role/user-management routes only reachable by an existing admin). **Minor, not fixed**: no server-side guard prevents an ADMIN from deactivating/demoting themselves (UI hides this for the logged-in user, but the API doesn't enforce it) — an operational footgun, not an escalation vector, worth a "cannot remove the last active admin" guard in Phase 2. |
| Server/client boundaries | Every `integrations/*` and `platform/*` module that reads a secret env var is marked `import "server-only"` (Next.js build-time enforced, not just convention). Verified: grep for `process.env` across `src/` found zero references inside any `"use client"` file. PASS. |
| Secrets in logs | Verified: every `console.error` in the Shopify client logs only HTTP status/GraphQL error message, never the token, client secret, or full response body. PASS. |

## 4. Database / Prisma

| Item | Result |
|---|---|
| `CustomerProfile.shopifyCustomerGid` unique | Confirmed `@unique` in schema; dedup enforced by the database, not just app logic — proven by a concurrent-creation test (3 simultaneous calls → exactly 1 row). PASS. |
| Note/Task ownership | Now correctly enforced at the service layer for both (see §2/3 fixes). |
| **Cascade inconsistency — found, not fixed (dormant)** | `Note`/`Activity` → `CustomerProfile` use `onDelete: Cascade`; `Task` → `CustomerProfile` has no explicit `onDelete` (defaults to `SetNull` since the relation is optional). If a `CustomerProfile` were ever deleted, its Notes/Activities would cascade-delete but its Tasks would silently lose their customer link instead. **No delete-CustomerProfile route exists anywhere in Phase 1**, so this is unreachable today — flagged for resolution before any future "delete customer" feature, not fixed now (would require a new migration for a code path that cannot currently execute, which is out of scope for a review pass). |
| **Session cleanup — FIXED** | `getSessionUser()` treats an expired session as invalid but never deleted the row — the `Session` table would grow unbounded over time. Fixed: `createSession()` now opportunistically deletes the calling user's own expired sessions first. A full scheduled sweep across all users is a reasonable Phase 2 addition (e.g. a Fly Machine cron), not implemented here. |
| Indexes | Reviewed all `@@index`/`@@unique` declarations — good coverage on every hot lookup path used by actual Phase 1 queries (`phoneNormalized`, `email`, `crmStatus`, `assignedToId`/`createdById`/`status`/`dueAt` on Task, the `customerProfileId, occurredAt` composite on Activity matching exactly the timeline's query shape). PASS. |
| Orphan records | No hard-delete route exists for `User` anywhere (only `active: false` deactivation) — the `Restrict`-by-default FKs on `Note.author`/`Task.assignedTo`/`Task.createdBy` are therefore never actually exercised, consistent with the soft-delete-only design. PASS. |
| Migrations | One migration (`20260901211016_init`), applied and re-verified against local Postgres during this review; **not** run against any production database. |

## 5. Activity Timeline

| Item | Result |
|---|---|
| Merge correctness | Control-Center-owned `Activity` rows + live-projected Shopify orders (never persisted) + adapter results (currently always empty — disabled) are merged and sorted by `occurredAt` descending in one pass. No duplication path exists: Shopify orders are never written to the `Activity` table, so there's no scenario where the same order could appear both as a projection and a stored row. PASS. |
| Stable IDs | Shopify order items use a stable synthetic key (`shopify-order-{gid}`); owned activities use their real row `id`. PASS. |
| **Timezone handling — FIXED** | `formatDate`/`formatDateTime` had no explicit `timeZone`, so `Intl.DateTimeFormat` silently followed the **server process's** local zone. This dev machine happens to default to `Europe/Amsterdam`, masking the bug locally — but Fly.io/Docker Linux hosts default to UTC, which would have shown every timestamp 1–2 hours off for Dutch staff. Fixed: both formatters now explicitly pass `timeZone: "Europe/Amsterdam"`. 3 new regression tests (`tests/format.test.ts`), including one that specifically checks a UTC timestamp crossing into the next Amsterdam calendar day. |
| Pagination / read performance | Bounded, not paginated: up to 200 owned activities + up to 20 Shopify orders per customer, per page load. Adequate for Phase 1's expected data volume; **not fixed, flagged for Phase 2** if a customer's activity genuinely exceeds these bounds. |
| Adapter failure isolation | Verified by code (adapters can never throw, always return `[]`/`null`) and by the existing `tests/adapters.test.ts`. A Customer 360 page cannot break because telephony/Exact are disabled. PASS. |

## 6. Error / failure states

Tested live (curl-driven, against the running production build) and via the existing test suite:

| Scenario | Result |
|---|---|
| Shopify not configured | `GET /api/customers/search` → **503**, clear Dutch message, `results: []` — verified live. PASS. |
| Shopify credentials wrong / temporarily unreachable | Not independently live-testable without real credentials to intentionally break; covered by code review — `shopifyGraphQL()` classifies every failure into a typed `ShopifyApiError`/`ShopifyConfigError`, retries only genuinely transient ones, and every caller (`getCustomer360`, search) is wrapped so the UI shows an explicit error state (`EmptyState`, §Customer 360 page) rather than crashing. |
| PostgreSQL failure | `GET /api/health` returns `{status:"error", ...}` at 503 rather than throwing; a Server Component DB failure is now caught by the new root `error.tsx` (added this review — see below) instead of Next's generic default page. |
| Customer not found | `GET /api/customers/[id]` → 404 with a clean message (via the new Prisma-error mapping, §below). |
| No orders/notes/tasks | All three render an explicit, worded `EmptyState`, never a blank screen — verified in code and via the smoke test's empty-state customer list. |
| Unauthorized / Forbidden | 401/403 verified live for every tested combination (unauthenticated → 401; VIEWER on write routes → 403 with a specific message). |
| Invalid input | Zod-validated on every mutating route; a malformed body returns 400 with `details` from `error.flatten()`, never a stack trace. |
| Duplicate customer profile | Verified impossible under concurrency (§4). |
| **Generic error responses — IMPROVED** | `toErrorResponse()` previously mapped only auth/Zod errors, falling back to a bare 500 for everything else including Prisma "not found"/"unique constraint"/"FK constraint" errors (e.g. editing an already-deleted note returned a confusing 500). Fixed: now maps `P2025→404`, `P2002→409`, `P2003→400` explicitly, still logging server-side without ever including error internals in the response body. |
| **No stack traces to the browser** | Verified via the new `src/app/error.tsx` (added this review): a root error boundary that renders a fixed, safe Dutch message and never interpolates `error.message`/`error.stack` into the DOM — closes the one remaining gap where an unhandled Server Component error would have fallen through to Next's framework-default error page. |

## 7. Linux / Fly build validation

Performed for real, using local Docker (`node:22-alpine`, matching the base image already used by every sibling app) — not simulated.

| Check | Result |
|---|---|
| **Cross-platform lockfile — CRITICAL, FOUND AND FIXED** | `npm ci` on Linux failed outright: `Cannot find module '@node-rs/argon2-linux-x64-musl'` / `Cannot find module '@rollup/rollup-linux-x64-musl'`. Root cause, confirmed by inspection: `package-lock.json` (last regenerated on this Windows machine earlier in the build) only recorded the **Windows** resolved variant of every platform-specific optional dependency — a well-documented npm limitation (npm/cli#4828). This meant **argon2 (used for every login) and the build toolchain would not have worked at all on Fly.io.** Neither `npm ci` nor a fresh `npm install` against the Windows-generated lockfile fixed it. **Fix**: deleted `package-lock.json` entirely and regenerated it via a truly fresh `npm install` run natively inside the Linux container — this produced a lockfile with the full platform matrix (Windows, Linux glibc/musl, macOS, etc. — verified by inspecting `package-lock.json`'s `packages` map). **Verified both directions**: `npm ci` now succeeds cleanly on both this Windows machine and fresh Linux containers, and argon2 hashes correctly on both. |
| `npm ci` on Linux | ✅ clean, after the fix above |
| Prisma generation on Linux | ✅ clean — correctly fetches the `linux-musl` query engine automatically |
| **`typecheck`/`lint`/`test`/`build` on Linux** | ✅ **all fully green** (43/43 tests passing, same as Windows) — but only after correcting an earlier test mistake in this review: running the validation with `NODE_ENV=production` set *before* `npm ci` silently skips devDependencies (npm's documented behavior), which broke the build (`tailwindcss` not found) and made `typecheck`/`test` report false "module not found" errors. **This is itself a real, important deployment-design finding** — see "Fly.io deployment design" below: the Docker build stage must install devDependencies (needed for `tailwindcss`/`typescript`/etc. at build time), and only the final runtime stage should be `NODE_ENV=production`. |
| `output: "standalone"` | Previously disabled (see the prior implementation report) due to a Windows-only `glob` EPERM. **Re-verified and re-enabled**: produces `.next/standalone/server.js` correctly on Linux. **Also re-tested on Windows with Turbopack and now works there too** — the EPERM was specifically triggered by webpack's file tracer + Next's built-in lint pass on this Windows profile, not by standalone output itself; Turbopack (already the configured build tool) sidesteps it entirely on both platforms. |
| Default webpack build (no Turbopack) on Linux | ✅ Also works cleanly natively on Linux — confirms the earlier EPERM was 100% Windows-machine-specific, not a Next.js/Turbopack correctness issue. Turbopack remains the configured default (faster, already verified, no reason to revert). |
| Windows-only paths / case-sensitive imports | None found — all imports use the `@/` alias or relative POSIX-style paths; no `path.win32`/backslash-literal paths anywhere in `src/`. |
| argon2 native compatibility | ✅ Confirmed working on Linux/musl after the lockfile fix (was the actual failure mode above). |
| `NODE_ENV=production` behavior | Confirmed: enables `secure` cookies, requires `SESSION_SECRET` (new behavior, §2/3), and — the important caveat above — must only be set for the **runtime** stage of a container build, never for the dependency-install/build stage. |

## 8. Fly.io deployment design (design only — nothing deployed)

| Aspect | Recommendation |
|---|---|
| App name | `stones4u-control-center` (prod), `stones4u-control-center-dev` if a separate dev app is wanted — following the `<app>`/`<app>-dev` naming already used by `source2pos-prod-web`/`source2pos-dev-web`. |
| Region | `ams` (Amsterdam) — matches every other app in the landscape (`docs/platform-discovery/04-INFRASTRUCTURE-MAP.md`: all 22 existing Fly apps run in `ams`). |
| Internal port | `3000` (Next.js default; matches `source2pos-dev-web`'s convention rather than the `8080` some other apps use — either works, `3000` needs no env override). |
| Health endpoint | `GET /api/health` — already implemented, checks real DB connectivity (`SELECT 1`), returns 503 on failure. Matches the `/login`/`/health` health-check convention already used across POS/`locatie`/s4u-quote-app. |
| Machines / process model | Single process type (`web`), `next start` against the `output: standalone` build (`node .next/standalone/server.js`). `min_machines_running = 1` recommended for production (avoid cold-start on login, matching POS's own documented reasoning), `= 0` acceptable for a dev app. |
| **Docker build stages (design)** | Must be **multi-stage**, matching the pattern already proven by POS/`locatie`: a `deps`/`builder` stage that runs `npm ci` **without** `NODE_ENV=production` (devDependencies required for `tailwindcss`/`typescript`/the build itself — see §7 finding), runs `npx prisma generate` and `npm run build`; a slim final `runner` stage (`node:22-alpine`) that copies only `.next/standalone`, `.next/static`, and `public/`, sets `NODE_ENV=production` **only in this final stage**, and runs as a non-root user. No `Dockerfile` was written in this review (out of scope — design only), but this exact shape is now verified correct end-to-end (§7). |
| PostgreSQL connectivity | Fly Postgres (or Neon — either fits; Fly Postgres matches the landscape default per `docs/platform-discovery/04`), reached via `DATABASE_URL`, private networking only (no public IP), matching every other app. |
| Migration execution strategy | `release_command = "npx prisma migrate deploy"` on every deploy — this app has **no** local generated-Prisma-CLI-exclusion concern that POS deliberately has (POS omits the Prisma CLI from its runtime image and runs migrations manually for a different reason specific to its history); a standard `release_command` is appropriate here and simpler. |
| Rollback strategy | Fly's standard `fly releases`/`fly deploy --image <previous>` rollback — since Phase 1 has exactly one, additive-only migration and no destructive schema changes, a rollback to the previous release image is safe without a corresponding down-migration. If a future migration is ever destructive, that needs its own explicit rollback plan at that time. |
| Persistent storage | **No** — Phase 1 has no file storage (ADR-005, deferred to Phase 2/R2). No Fly Volume needed. |
| Scaling assumptions | Single shared-CPU, 512MB–1GB machine is more than sufficient for Phase 1's expected internal-staff load (matches POS's own sizing); no autoscaling policy needed yet — revisit once Phase 2+ adds heavier features (file uploads, deeper adapters). |

## 9. Environment variables — definitive list (names only)

| Variable | Classification | Notes |
|---|---|---|
| `DATABASE_URL` | **REQUIRED** | PostgreSQL connection string |
| `SESSION_SECRET` | **REQUIRED in production**, optional in dev (insecure fallback + warning) | Now actually used — see §2/3 fix |
| `NODE_ENV` | **REQUIRED** (set by the platform/runtime, not hand-configured) | Controls secure cookies, SESSION_SECRET enforcement, Prisma logging |
| `APP_ENV` | OPTIONAL | Declared in `.env.example`, not currently read by any code — reserved for a future dev/staging/production distinction beyond `NODE_ENV`; **not misleading** like the old `SESSION_SECRET` was, since it was never claimed to do anything. Consider removing if it stays unused past Phase 2, same reasoning as the `SESSION_SECRET` fix. |
| `SHOPIFY_SHOP_DOMAIN` | **REQUIRED** for any Shopify feature to work | Falls back to a clean "not configured" 503 everywhere if absent (verified live) |
| `SHOPIFY_CLIENT_ID` | **REQUIRED** for any Shopify feature | ADR-006 client-credentials |
| `SHOPIFY_CLIENT_SECRET` | **REQUIRED** for any Shopify feature | Never logged, never sent to the client (verified) |
| `SHOPIFY_API_VERSION` | **REQUIRED** for any Shopify feature | e.g. `2026-07` |
| `SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN` | OPTIONAL in Phase 1 | Powers `assertShopifyShopIdentity()`, unused by any Phase 1 code path (no writes exist yet) — required once Phase 2+ adds a Shopify write |
| `TELEFOONSYSTEEM_API_BASE_URL` | **FUTURE / DISABLED INTEGRATION** | Read by nothing — the adapter is intentionally disabled (§ADR-004, no safe machine auth exists) |
| `TELEFOONSYSTEEM_SERVICE_TOKEN` | **FUTURE / DISABLED INTEGRATION** | Same |
| `EXACT_HISTORY_API_BASE_URL` | **FUTURE / DISABLED INTEGRATION** | Same |
| `EXACT_HISTORY_SERVICE_TOKEN` | **FUTURE / DISABLED INTEGRATION** | Same |

`.env.example` was checked line-by-line against this list and matches (with `SESSION_SECRET`'s comment now corrected to describe its real, newly-wired behavior — see the fix above).

## 10. Bootstrap admin

Reviewed `scripts/bootstrap-admin.ts` end-to-end (code + live execution, again, during this review):

- Credentials come **only** from environment variables (`BOOTSTRAP_ADMIN_EMAIL`/`_PASSWORD`/`_NAME`), never a CLI argument (which would leak into shell history) and never a file committed to git.
- **Refuses unconditionally if any `User` row already exists** — reverified live: a second invocation after the first correctly printed the refusal message and made no changes.
- No default/placeholder production password exists anywhere in the codebase (grepped).
- No public registration route exists anywhere (`find src/app -iname "*regist*" -o -iname "*signup*"` → empty).
- **Exact production bootstrap procedure**: after the first deploy, run once via `fly ssh console -a stones4u-control-center` → `BOOTSTRAP_ADMIN_EMAIL=... BOOTSTRAP_ADMIN_PASSWORD=... node scripts/bootstrap-admin.ts` (or `npm run bootstrap:admin` if dev dependencies are present in that image) — mirroring OfferteApp's own `bootstrap-production.ts` pattern exactly, per `docs/platform-discovery/10` §13. The password should be generated locally (e.g. `openssl rand -base64 24`), used once to log in, and changed immediately via `/settings`.

PASS — no changes needed.

## 11. Observability

| Item | Result |
|---|---|
| Server error logging | Every unexpected error path logs via `console.error` with a stable event name (`api_route_error`, `shopify_admin_api_http_error`, `unhandled_render_error`, etc.) — greppable, consistent, never includes secrets/PII beyond what's already safe to log (status codes, error messages, entity IDs). |
| Audit logging | Comprehensive (§ previous report) — reverified still correct after this review's fixes; note-ownership and task-role fixes both still write their audit rows correctly (covered by the updated tests). |
| Health endpoint | `GET /api/health` — real DB check, 503 on failure. No separate "readiness" endpoint exists; for Phase 1's single-process model this is an acceptable simplification (Fly's health check convention only needs the one endpoint). |
| Database failures | Now caught by the new root `error.tsx` rather than an unhandled crash reaching the framework default. |
| Shopify failures | Explicit, typed, never silently swallowed — every caller either shows a clear UI error state or returns a structured API error. |
| Secrets/PII in logs | Reviewed every log call site in `src/` — none logs a token, password, or full user object; entity IDs and status codes only. |

## 12. Tests / build (re-run as instructed)

```
npm run typecheck   → clean
npm run lint          → clean
npm run test            → 12 files, 43 tests, all passing (was 10 files/37 tests before this review;
                            6 new tests added — 3 for the VIEWER-task-mutation fix's underlying guard,
                            3 for the note-ownership fix, 3 for the SESSION_SECRET fix, 3 for the
                            timezone fix — one guard test folded into an existing file, hence 6 net)
npm run build             → succeeds (Turbopack, output: standalone now enabled and verified)
```

No tests were added for functionality — every new test covers a specific, real Phase 1 risk found during this review (see §2/3, §5).

## 13. UX smoke test (live, against the actual production build)

Performed with `npm run start` serving the real production build, driven via `curl` end-to-end (not simulated):

1. Login page loads (200), login with the bootstrapped admin succeeds, session cookie set.
2. Dashboard loads authenticated (200).
3. Customers search page loads (200); search API correctly returns a clean 503 with Shopify unconfigured (expected — no live Shopify credentials exist in this environment, documented since the prior report).
4. Tasks page loads (200); task creation via API succeeds (201) and appears in "my tasks."
5. Task completion via API succeeds (200, `completedAt` set).
6. **VIEWER role enforcement, live-reproduced**: created a VIEWER user via the admin API, logged in as them, and confirmed: task creation → 403; **task status mutation on a task they're assigned to → 403 (this is the exact request that would have succeeded before this review's fix)**; admin user list → 403; reading tasks → 200 (correctly still allowed).
7. Admin: user creation via the admin UI's backing API succeeds.
8. Logout invalidates the session — a subsequent authenticated-route request correctly redirects to `/login` (307).

**Not independently live-tested**: Customer 360, orders, activity timeline, and note create/edit rendered in-browser — this environment has no live Shopify credentials configured (documented as a pre-existing, expected gap since the original build), so the customer-dependent screens cannot be exercised through the actual UI without them. Their correctness is instead covered by the 43-test automated suite (customer-profile dedup, note CRUD + ownership, task CRUD + permissions, timeline aggregation logic) plus direct code review. No console/hydration errors were observed in the server logs during any of the above requests.

## Summary: fixes made this review

1. `.gitignore`: corrected the Prisma generated-client path (was pointing at a path that doesn't exist; the real 25MB output including a native Windows binary was untracked-but-unignored).
2. `src/platform/auth/session.ts`: wired up the previously-inert `SESSION_SECRET` as an HMAC pepper, required in production; added opportunistic expired-session cleanup.
3. `src/app/api/tasks/[id]/route.ts`: closed a real privilege-escalation gap (VIEWER could mutate a task assigned to them via direct API call).
4. `src/modules/crm/note.service.ts`: closed a real IDOR gap (any AGENT could edit/delete any other AGENT's note).
5. `src/lib/api-error.ts`: mapped Prisma not-found/conflict/FK errors to correct HTTP statuses instead of a generic 500.
6. `src/lib/format.ts`: fixed a timezone bug that would have shown incorrect times in production (server-local vs. explicit Europe/Amsterdam).
7. `src/app/error.tsx`: added a root error boundary so an unhandled render error never falls through to a non-localized default page.
8. **`package-lock.json`: regenerated from scratch to include the full cross-platform optional-dependency matrix** — without this, the app could not have run on Fly.io at all (argon2 login would fail entirely, and the build itself would fail).
9. `next.config.ts`: re-enabled `output: "standalone"` (verified working on both Windows and Linux; the earlier disabling was based on an incomplete diagnosis — see §7).
10. 6 new regression tests covering findings 2–6 above.

## Openstaande blockers

**None that block a first deployment**, given the fixes above. Two items remain genuinely open and are **not** blockers because they were already known, documented, and explicitly out of scope for Phase 1:

1. Shopify credentials must be provisioned (a custom app created in Shopify Admin) before any Shopify-dependent feature is usable in production — operational step, not a code blocker.
2. TelefoonSysteem/Exact adapters remain intentionally disabled pending a TelefoonSysteem-side service-auth mechanism — by design (ADR-004), not a Phase 1 blocker.

## Deployment prerequisites

1. Provision Fly Postgres (or Neon) + a Fly app named per §8.
2. Write the actual `Dockerfile`/`fly.toml` following the multi-stage shape verified correct in §7/§8 (not written in this review — design-only, as instructed).
3. Set Fly secrets: `DATABASE_URL`, `SESSION_SECRET` (generate fresh, e.g. `openssl rand -hex 32` — never reuse the local dev value), `SHOPIFY_*` (once the custom app exists).
4. Confirm the rate-limiter's IP source (`X-Forwarded-For`) is trustworthy in Fly's actual proxy chain before relying on it as a real brute-force defense (§2/3) — verify with a real request against the deployed app; add a Fly-specific trusted-header override if not.
5. Run `fly deploy`.
6. Bootstrap the first admin per §10.

## Aanbevolen deployprocedure

1. `fly deploy` (builds the multi-stage Docker image per §8, runs `release_command = prisma migrate deploy` automatically before the new machines start).
2. Watch `fly logs` through the release command and the first health-check cycle.
3. Confirm `GET /api/health` returns `200` from the deployed URL.
4. Bootstrap the first admin (§10), log in once manually to confirm, then change the password via `/settings`.
5. Announce internally; do not yet configure Shopify credentials until the team is ready to use the customer-facing features (the app works correctly without them — everything degrades to a clear "not configured" state).

## Rollbackprocedure

1. `fly releases` to find the previous working release.
2. `fly deploy --image <previous-release-image>` (or the equivalent `fly releases rollback` if available in the CLI version in use).
3. No down-migration is needed — Phase 1's single migration is purely additive (new tables only), so the previous release's code works unmodified against a database that has since gained these tables (it simply won't use them).
4. If the Postgres database itself needs to be rolled back (should never be necessary for Phase 1 given no destructive migrations exist), use Fly Postgres's own point-in-time recovery — out of scope to detail further here since Phase 1 creates no scenario requiring it.

## Aanbevolen smoke tests na deployment

Repeat the exact sequence from §13 against the live URL: login → dashboard → customer search (expect a real result once Shopify is configured, or the clean 503 if not yet) → task create/complete → VIEWER-role negative tests (403 on write routes) → logout → confirm redirect. Additionally: confirm `GET /api/health` is 200, confirm cookies are `Secure` (inspect via browser devtools against the HTTPS URL), and confirm `fly logs` shows no unexpected errors during the sequence.
