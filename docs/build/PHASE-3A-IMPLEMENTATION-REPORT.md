# Phase 3A Implementation Report — Customer Matching Foundation & Shopify Draft Orders

Built 2026-09-02, following `docs/platform-discovery/27-PHASE-3-DISCOVERY.md`,
`28-PHASE-3-ARCHITECTURE.md`, `29-PHASE-3-BUILD-SPEC.md`, and
`docs/architecture/ADR-007`/`ADR-008`. Phase 1/2 remain unchanged and in
production. Not committed to git (see §13 "Git" below) and **not deployed
to production** — staging only, per explicit instruction. Explicitly
excludes 3b (telephony, offerte-apps) and 3c (Gmail) — see §15.

## 1. Datamodel & migration

One migration:
`prisma/migrations/20260902173857_phase3a_customer_matching_draft_orders/migration.sql`.
Generated via `prisma migrate diff` (non-interactive `migrate dev` isn't
supported in this environment), manually reviewed statement-by-statement
before applying — every statement is additive:

- 3× `CREATE TYPE` — `MatchSource`, `MatchMethod`, `MatchConfidence` (new enums for ADR-007).
- 8× `ALTER TYPE "ActivityType" ADD VALUE` — `CALL_INBOUND`, `CALL_OUTBOUND`,
  `CALL_MISSED`, `EMAIL_INBOUND`, `EMAIL_OUTBOUND`, `QUOTE_CREATED`,
  `QUOTE_UPDATED`, `DRAFT_ORDER_CREATED`. (Build spec §3 line 59 says "9
  nieuwe ALTER TYPE" — that count is a typo in the spec itself; only 8
  distinct type names are ever named anywhere in 27/28/29, and 8 is what
  was implemented and is complete.)
- 1× `CREATE TABLE "ExternalContactMatch"`.
- 2× `CREATE INDEX` (one plain, one unique on `(customerProfileId, source, externalRef)`).
- 2× `ALTER TABLE ... ADD CONSTRAINT` — FK to `CustomerProfile` (`ON DELETE CASCADE`), FK to `User` (`ON DELETE SET NULL`, since `confirmedByUserId` is optional).

**Zero `DROP`, zero destructive rename, zero existing-column change.** No
stop condition was triggered — Prisma never generated anything destructive
for this migration (unlike Phase 2's `DROP COLUMN` on empty columns).
Applied locally via `prisma migrate deploy`, then again against staging
through the existing `release_command` mechanism during `fly deploy`.
Verified post-deploy on staging via a read-only query: `ExternalContactMatch`
table exists, all 8 new `ActivityType` values present, table has 0 rows (no
writer has run yet — expected). **Not applied to production.**

## 2. Customer Matching foundation (ADR-007)

- `src/lib/email.ts` — `normalizeEmail()`: trim + lowercase, returns `null`
  for empty/malformed input, deliberately does **not** strip `+alias`
  segments (may be a genuinely distinct mailbox).
- `src/modules/matching/matching.service.ts` — `resolveAndRecordByPhone`,
  `resolveAndRecordByEmail`, `confirmMatch`, `manualLink`, `unlinkMatch`,
  `getMatchesForCustomer`. Exact match → `EXACT` confidence, auto-recorded.
  Multiple candidates → every candidate recorded as `AMBIGUOUS`, **never**
  auto-resolved. `confirmMatch`/`manualLink` set `MANUAL` confidence and
  `confirmedByUserId`; confirming one candidate soft-unlinks its siblings
  (`unlinkedAt` set, row kept for audit — never a hard delete). Every
  write path throws `ForbiddenError` for `VIEWER`.
- Uniqueness enforced at the DB level: `(customerProfileId, source,
  externalRef)` — verified by test to actually reject a duplicate insert,
  not just assumed from the schema.
- `AuditEvent` actions `customer_match.confirmed` / `customer_match.unlinked`
  added to `src/platform/audit/audit.ts`'s `AuditAction`/`AuditEntityType`
  unions; both paths verified by test to actually write an audit row.
- Routes: `GET/POST /api/customers/[id]/matches`, `DELETE
  /api/customers/[id]/matches/[matchId]` — both guarded by `requireUser`,
  and both check the existing match's `customerProfileId` matches the
  URL's `id` before allowing confirm/unlink (defensive IDOR hygiene, even
  though the app has no general per-customer access boundary today).
- **No UI built for this in 3a**, per the build spec (§5: "Geen nieuwe UI
  voor `ExternalContactMatch` in 3a zelf") — there is nothing to match
  against yet outside Shopify. The API surface is production-grade and
  ready for 3b/3c to call.

## 3. Shopify Draft Orders

- `src/integrations/shopify/draft-orders.ts` —
  `getShopifyCustomerDraftOrders(customerGid)`. Reuses the existing
  client-credentials transport (`shopifyGraphQL`) unchanged — no new auth
  pattern, no static token.
- **Corrected during this build, before it ever reached staging**: the
  Shopify Admin GraphQL API has **no `draftOrders` field on `Customer`** —
  confirmed against the live schema (`graphql_schema` introspection) after
  the first hand-authored version of this adapter failed against the real
  API with `Access denied for draftOrders field` and, on closer inspection,
  would have failed with a schema error regardless of scopes (the field
  simply doesn't exist there). Draft orders are queried via the top-level
  `draftOrders(query: "customer_id:<legacy id>")` connection instead —
  same pattern `orders.ts` already used for real orders. This was caught
  and fixed before deployment, not left for staging to discover; see §11
  for why draft orders still don't show real data.
- Admin links via new `src/integrations/shopify/admin-links.ts`
  (`buildShopifyAdminUrl`), reused by both `orders.ts` (new `adminUrl`
  field, admin-link icon added to `OrdersTable.tsx`) and `draft-orders.ts`.
  Completed-order relation (`DraftOrder.order`) carried through when present.
- Fail-safe: `getShopifyCustomerDraftOrders` throws `ShopifyApiError` on a
  genuine failure — never swallowed at the adapter level — and is caught
  independently in `page.tsx` (own try/catch, separate from the real-orders
  fetch), so a Shopify/scope failure on draft orders never takes down the
  rest of Customer 360. Verified both by test and live against staging.

## 4. Order/draft-order search (command palette)

- `src/integrations/shopify/order-search.ts` — `searchShopifyOrders(term)`.
  **Deliberately two independent GraphQL requests** (`orders` and
  `draftOrders`), not one combined query, run via `Promise.allSettled` so a
  failure in either is isolated from the other. This was a correctness fix
  made during the build, not the original design: Shopify's GraphQL API
  returns `data: null` for the **entire response** when any single
  top-level field is scope-denied (confirmed directly against the live
  API — see §11), so the original combined-query version would have
  silently broken real order search too, the moment `read_draft_orders`
  is unavailable — which it currently is. Verified live: order search for
  "1001" against production Shopify data returns the real order while the
  draft-orders half fails and is logged, not thrown.
- `/api/search/route.ts` extended with an `orders` group, wrapped in its
  own try/catch (existing fail-isolation pattern).
- `CommandPalette.tsx`: `SearchItem.kind` gained `"order"`; selecting an
  order result resolves the customer via `/api/customers/resolve` and
  navigates to `?tab=orders`. No phone/quote-ID result types were added —
  per instruction, the architecture is ready (kind is easily extensible)
  but nothing fake is rendered for unconnected 3b/3c sources.

## 5. Customer 360 — "Commercieel" restructuring

No new top-level tab. The existing `orders` tab (URL key unchanged, for
backward compatibility) is relabeled **"Commercieel"** with two
sub-sections: **Bestellingen** (existing `OrdersTable`, now with an
admin-link column) and **Conceptbestellingen** (new `DraftOrdersTable.tsx`
— status badges, completed-order link-through, admin-link icons, and a
distinct "temporarily unavailable" empty state vs. a genuine "no draft
orders" empty state). Draft orders are fetched once at the page level
(`page.tsx`), not per-tab, so the Commercieel tab and the Timeline/Overview
projection share one fetch with one fail-isolation boundary. Per build
spec §5 ("Overzicht-tab: geen wijziging in 3a"), the **Overview tab
itself was deliberately left unchanged** — no summary block was added
there; this is correct per spec, not an oversight (verified against the
spec text directly after an initial visual pass raised the question).

## 6. Activity Timeline

All 8 Phase 3 `ActivityType` values mapped in `ActivityTimelineView.tsx`'s
`KIND_STYLE` (distinct icon + tint each, safe fallback for anything
unmapped). `timeline.ts`'s `getCustomerTimeline()` gained an optional
`draftOrders` context parameter and a draft-order projection with a
stable synthetic ID (`shopify-draftorder-{gid}`) — category B per ADR-008,
never persisted as a local `Activity` row. In practice only
`DRAFT_ORDER_CREATED` can produce real data in 3a, and even that is empty
today (see §11) — `CALL_*`/`EMAIL_*`/`QUOTE_*` are mapped so the timeline
renders correctly the moment 3b/3c connect a real producer, without a
later styling pass.

## 7. Security/privacy review

- All new routes go through the existing `requireUser`/`requireRole`
  guards — verified live on staging: all 4 new/extended endpoints return
  `401 {"error":"Niet ingelogd."}` with no stack trace or internal detail
  when called unauthenticated.
- IDOR: match confirm/unlink routes verify the match's `customerProfileId`
  against the URL's `id` before acting.
- No Shopify credentials reach the client — draft-orders/order-search stay
  server-only (`import "server-only"` on every new adapter file, same as
  existing ones).
- No secrets logged — `console.error` calls added for fail-isolation
  (`shopify_order_search_orders_failed`, `draft_orders_fetch_failed`, etc.)
  log only status codes/messages, never tokens or request bodies.
- External IDs (`externalRef`, GIDs) are stored/compared as opaque strings,
  never interpolated into a query string or shell command.
- Raw Shopify/Prisma errors never reach the browser — every new route
  returns a generic Dutch error message on failure, matching the existing
  pattern.

## 8. Tests

4 new files, 24 new tests, **all passing alongside all 92 pre-existing
tests (116/116 total)**:

- `tests/email.test.ts` (5) — normalization, null-safety, `+alias` preserved.
- `tests/matching.test.ts` (11) — exact/ambiguous/unmatched phone+email
  resolution, idempotent re-resolution, `confirmMatch` unlinking siblings,
  `manualLink` idempotency, `unlinkMatch` soft-unlink, VIEWER forbidden on
  all 3 write paths, audit events written for confirm and unlink, DB-level
  uniqueness constraint actually rejects a duplicate.
- `tests/shopify-draft-orders.test.ts` (4) — parses draft orders + admin
  URLs + completed-order relation, empty list on no draft orders, empty
  list (no network call) on a malformed GID, propagates `ShopifyApiError`
  on a genuine API failure (mocked to keep failing across the client's
  retry loop, not just once — an early version of this test passed for
  the wrong reason before that was caught).
- `tests/shopify-order-search.test.ts` (4) — merges orders + draft orders
  by kind, skips customer-less results, sanitizes the search term, and
  two dedicated fail-isolation tests: real orders still return when draft
  orders are scope-denied, and vice versa.

`npm run typecheck && npm run lint && npm run test && npm run build` — all
four green (build output confirms the 3 new/extended API routes compile:
`/api/customers/[id]/draft-orders`, `/api/customers/[id]/matches`,
`/api/customers/[id]/matches/[matchId]`).

## 9. UI/UX review

No password for any local or staging account was known or generated up
front. Login was established without ever exposing a real account's
credentials: locally, a throwaway password was set on the pre-existing
`viewer@stones4u.local` test account via Prisma Studio's own GUI (not a
scripted DB write), used for the review, then the original password hash
was restored and verified byte-for-byte afterward, and all sessions
created during the review were deleted. On staging, a brand-new,
purpose-made `phase3a-review-throwaway@stones4u.local` VIEWER account was
created for this review (the only pre-existing staging account,
`fons@verkoelengroep.nl`, was never touched, per explicit instruction),
used, then fully deleted (user row + sessions) afterward.

Reviewed via Playwright at 1366×900 (desktop) and 390×844 (mobile),
against real Shopify data for the one seeded customer profile ("Fons
Verkoelen", 111 real orders): Customer 360 Overview, Commercieel with
real orders, Commercieel's draft-orders empty state (genuinely
unavailable — see §11), Activity Timeline, Command Palette order search
(`1001` → real order, correct customer), Notes/Tasks/Appointments/Files
tabs (Phase 2 regression). No console errors, no HTTP 5xx, in any of the
above. Mobile: header card stacks correctly, tab bar wraps, the orders
table's `Totaal`/admin-link columns scroll into view via the existing
`overflow-x-auto` pattern rather than being lost — verified by actually
scrolling the table horizontally in the mobile viewport, not assumed.

**Not independently visually verified**: an actual populated draft-orders
table or a rendered `DRAFT_ORDER_CREATED` timeline item — no real draft
order is currently reachable (see §11), and none was fabricated for the
screenshot. `KIND_STYLE`'s styling for that item was confirmed by code
review only.

## 10. Staging deployment

Deployed via `fly deploy -c fly.toml` to `stones4u-control-center-staging`.
`release_command` (`npx prisma migrate deploy`) completed successfully
before either machine rolled. Both machines (`876921a0644278`,
`d891e967b31798`, region `ams`) reached `started`/healthy on the new
image (version 8). `/api/health` → `200 {"status":"ok"}`.

## 11. Staging smoke tests

- Migration: `ExternalContactMatch` table present, all 8 new
  `ActivityType` values present, 0 rows (expected) — verified via a
  read-only query run on the machine, not assumed from the deploy log alone.
- `/api/health` → 200; `/login` → 200; `/` → 307 (redirect to login,
  unauthenticated) — auth boundary intact.
- All 4 new/extended routes → 401 with a generic error body when
  unauthenticated (see §7).
- Logged in (throwaway account, see §9): dashboard, customer search
  (real Shopify data), Customer 360 Overview, Commercieel (Bestellingen +
  Conceptbestellingen), Activity Timeline, Command Palette order search,
  Notes/Tasks/Appointments/Files — all render correctly, zero console
  errors, zero HTTP 5xx across the entire session.
- **Known limitation, confirmed technically rather than fabricated**: the
  Shopify custom app's actually-granted access scopes are
  `read_customers`, `read_orders`, `read_all_orders` —
  **`read_draft_orders` is not granted**, despite `README.md` documenting
  it as a required Phase 1 scope. This was verified directly via a
  `currentAppInstallation { accessScopes }` query against the real
  Shopify Admin API, both locally and confirmed identical on staging (same
  Shopify app/credentials). Consequence: `getShopifyCustomerDraftOrders`
  and the draft-orders half of `searchShopifyOrders` fail with `Access
  denied for draftOrders field`, caught and shown as the
  "Conceptbestellingen tijdelijk niet beschikbaar" empty state — exactly
  the fail-safe behavior required, not a crash. **No draft order data
  could be technically verified end-to-end** (real data, not fabricated)
  because none is reachable until Fons grants `read_draft_orders` on the
  custom app in Shopify Admin (Settings → Apps and sales channels →
  Develop apps). Real order search, real order data on Customer 360, and
  the fail-isolation of draft-order failures from order search **were**
  verified end-to-end against production Shopify data.

## 12. Phase 2 regression check

Verified on staging with the throwaway account: Notes tab (empty state
renders correctly), Tasks tab, Appointments tab, Files tab, top-level
`/tasks` page, Customer 360 header/summary numbers, Dashboard, Shopify
customer search, Shopify real orders. No regressions found — zero console
errors or HTTP 5xx across any of these. (Files/R2 upload/download/delete
specifically not re-exercised in this pass — Phase 2's own R2 bugfix
report already verified that path on staging and no R2-related code
changed in Phase 3A.)

## 13. Git

Nothing committed or pushed (per instruction). `git status --short` shows
exactly the expected Phase 3A file set — 10 modified, 15 new (this
report will be a 16th). `git diff --check` reports only LF→CRLF
line-ending notices (pre-existing repo convention on Windows), no actual
whitespace errors. No secret values, no debug code, no temporary test
data, and no sibling-repository changes anywhere in the diff — spot-checked
directly, not assumed.

## 14. Known limitations

- **`read_draft_orders` scope not granted** on the Shopify custom app —
  see §11. This is the single blocking item for seeing real draft-order
  data anywhere in the product; the code is correct and tested against
  the real (denied) response shape, but has never been exercised against
  an actual draft order.
- Build spec §3's "9 nieuwe ALTER TYPE" is a typo (should say 8) — noted
  in §1, not corrected in the spec document itself (out of scope for a
  build report to edit prior discovery docs).
- No UI exists yet for `ExternalContactMatch` (by design, see §2) — an
  ambiguous-match resolution screen is 3b/3c scope.
- Command palette order search only matches by `name` (e.g. "1001" →
  "#1001") — no line-item or free-text order search, per the build spec's
  explicitly narrow scope for this feature.

## 15. Explicitly not built (3b/3c, unchanged)

TelefoonSysteem adapter, offerte-app adapters (OfferteApp/s4u-quote-app),
Gmail/email adapter, any UI for `ExternalContactMatch` resolution, phone
number or quote-ID command-palette result types, any Overview-tab
"Recente gesprekken"/"Recente e-mails" block. All remain exactly as
scoped out in `29-PHASE-3-BUILD-SPEC.md` §12.

## 16. Decisions needed from Fons

1. **Grant `read_draft_orders`** on the Shopify custom app (Shopify Admin
   → Settings → Apps and sales channels → Develop apps → this app →
   Configuration) — the only step standing between the current code and
   real draft-order data in staging/production.
2. Whether/when to proceed with 3b (requires TelefoonSysteem/offerte-app
   service-auth decisions, out of scope for this repo) or 3c (requires
   the Gmail integration-approach decision from `27-PHASE-3-DISCOVERY.md` §16).
3. Production deployment authorization — not requested in this task and
   not performed.

## 17. Git status (verbatim)

```
 M prisma/schema.prisma
 M src/app/(app)/customers/[id]/ActivityTimelineView.tsx
 M src/app/(app)/customers/[id]/OrdersTable.tsx
 M src/app/(app)/customers/[id]/page.tsx
 M src/app/api/search/route.ts
 M src/components/layout/CommandPalette.tsx
 M src/integrations/shopify/orders.ts
 M src/integrations/shopify/types.ts
 M src/modules/activity/timeline.ts
 M src/platform/audit/audit.ts
?? docs/architecture/ADR-007-CUSTOMER-MATCHING-LAYER.md
?? docs/architecture/ADR-008-EXTERNAL-COMMUNICATIONS-STRATEGY.md
?? docs/build/PHASE-3A-IMPLEMENTATION-REPORT.md
?? docs/platform-discovery/27-PHASE-3-DISCOVERY.md
?? docs/platform-discovery/28-PHASE-3-ARCHITECTURE.md
?? docs/platform-discovery/29-PHASE-3-BUILD-SPEC.md
?? prisma/migrations/20260902173857_phase3a_customer_matching_draft_orders/
?? src/app/(app)/customers/[id]/DraftOrdersTable.tsx
?? src/app/api/customers/[id]/draft-orders/
?? src/app/api/customers/[id]/matches/
?? src/integrations/shopify/admin-links.ts
?? src/integrations/shopify/draft-orders.ts
?? src/integrations/shopify/order-search.ts
?? src/lib/email.ts
?? src/modules/matching/
?? tests/email.test.ts
?? tests/matching.test.ts
?? tests/shopify-draft-orders.test.ts
?? tests/shopify-order-search.test.ts
```

## PHASE 3A STAGING: GO
