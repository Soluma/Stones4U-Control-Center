# Order-Based Delivery Handoff — Foundation (Phase 6B)

Technical foundation for moving the gewenste-leverdatum-handoff from Shopify
Draft Order to a real Shopify Order, decoupled from payment/invoicing. This
phase builds the data model, Order-mirror, and service-layer functions only —
no webhook, no staff UI, no public UX change, no email, no automatic
eligibility trigger, and no production/staging deploy. See
`docs/QUOTE-DELIVERY-DATE-MANUAL-ACTIVATION.md` for the existing, unchanged
Draft-based flow this sits alongside.

## Architectural decisions (given, not re-derived this phase)

- **Trigger** (a later phase): `orders/create`, not `orders/paid` — payment,
  order, invoice, and delivery stay separate concepts (§"B2B boundary"
  below).
- **Shopify write**: the eventual Order mirror writes
  `requested_delivery_date = YYYY-MM-DD` directly onto the real Order.
- **Scope**: `write_orders` is required but not changed in this phase —
  readiness only (§"write_orders status").
- **Notification**: Control Center will later own notification
  orchestration itself — no OfferteApp, no Shopify Flow dependency, provider
  choice stays behind an interface/outbox (not built yet).
- **Eligibility**: not a solved problem yet — no automatic eligibility
  trigger exists in this phase.
- **Token**: no fixed expiry introduced; existing regenerate/change
  behavior is reused unchanged.
- **History**: the existing Draft canary (`#D684`,
  `cmtud65er0001r4nifcu95u6j`) is never rewritten or migrated to an Order.

## Data model decision

Compared four options for representing "is this handoff a Draft Order or a
real Order" without ambiguity:

| Option | Shape | Verdict |
|---|---|---|
| A | `commerceObjectType` + `externalId` only | Rejected — inconsistent with this table's own established convention of a dedicated, explicit GID field (`shopifyDraftOrderGid` already exists for exactly this reason) |
| B | `externalId` + `shopifyOrderGid`, no enum | Rejected — "type" would be inferred from which nullable GID field happens to be set; fragile, and exactly the kind of implicit dispatch the dispatch layer must avoid |
| **C (chosen)** | `commerceObjectType` enum + `shopifyOrderGid` + existing `externalId`/`shopifyDraftOrderGid` | Smallest design consistent with the table's existing pattern |
| D | Two explicit nullable GIDs, no enum | Rejected for the same reason as B — no enum means no compile-time-checkable discriminator |

**Why not skip the enum** ("don't add an enum because it sounds nicer"): a
Shopify GID string already technically encodes its own type
(`gid://shopify/DraftOrder/…` vs `gid://shopify/Order/…`), but dispatch code
must never branch on parsing that string — see "Service abstraction" below.
An explicit, typed column is the only way to make Draft-vs-Order dispatch a
compile-time-checkable decision rather than a runtime string-sniff.

Migration (`20260909202443_phase6b_order_delivery_handoff_foundation`) is
purely additive — one new enum type, three new nullable/defaulted columns,
zero `DROP`/`RENAME`/`ALTER` on any existing column:

```sql
CREATE TYPE "DeliveryCommerceObjectType" AS ENUM ('SHOPIFY_DRAFT_ORDER', 'SHOPIFY_ORDER');

ALTER TABLE "DeliveryDateHandoff" ADD COLUMN "commerceObjectType" "DeliveryCommerceObjectType" NOT NULL DEFAULT 'SHOPIFY_DRAFT_ORDER',
ADD COLUMN "publicReference" TEXT,
ADD COLUMN "shopifyOrderGid" TEXT;
```

`commerceObjectType`'s `NOT NULL DEFAULT 'SHOPIFY_DRAFT_ORDER'` backfills
every historical row (including the production canary) to the correct type
automatically — never ambiguous, never `SHOPIFY_ORDER` by accident.

## Uniqueness / idempotency

No new constraint was needed. The existing
`@@unique([sourceSystem, externalId])` already guarantees at most one
handoff per Draft Order *or* per Order — a Draft GID and an Order GID never
collide as strings, so the same constraint that has always protected the
Draft flow protects the Order flow for free.

## `publicReference`

New nullable `String?` column, populated once at creation time from
Shopify's own `order.name` (e.g. `"#1234"`) — never a GID, never PII, never
fabricated when unavailable, never backfilled for historical rows. Exists
so a future public page (Phase 6D) never needs its own Shopify read just to
show a friendly order reference.

**Hardening** (final review): `normalizePublicReference()` trims
whitespace, collapses an empty or whitespace-only value to `null` (never
stores `""`), and caps length at 64 characters — generous headroom for
real Shopify order names (`"#1234"`, `"#WEB1234"`), not a byte more than
needed to guard against something unexpectedly long. Deliberately no
character stripping or other content normalization — Shopify's
order-naming scheme is per-shop-configurable and must not be
second-guessed here. The value always originates server-side from
`order.name`, never from a public request. Rendering it (Phase 6D) is
plain React text interpolation — never `dangerouslySetInnerHTML` — so no
HTML-escaping concern here either.

## Order read client

`src/integrations/shopify/order-for-handoff.ts` — `getOrderForHandoff()`.
Read-only, minimal: Order GID, name, `cancelledAt`, fulfillment status,
customer GID (identity only, never name/email/phone), shipping-address
*presence* (not its content — a signal explored in Phase 6A discovery, not
wired into any automatic decision here), and whether a
`requested_delivery_date` attribute already exists. Never called from the
public `/delivery/[token]` flow — only from staff-facing (or, later,
webhook-triggered) handoff creation.

## Order mirror

`src/integrations/shopify/order-mirror.ts` —
`mirrorRequestedDeliveryDateToOrder(orderGid, dateIso)`. Direct parity with
the proven `mirrorRequestedDeliveryDateToShopify()` (Draft): calls
`assertShopifyWriteAllowed()` first, every time; minimal read (`id`,
`cancelledAt`, `customAttributes`); read-merge-write that preserves every
unrelated attribute and guarantees exactly one `requested_delivery_date`
key, replacing duplicates if any exist; idempotent for a resubmitted,
already-current value. Refuses to mutate a cancelled Order — checked as
part of the same read used for the merge, before any mutation is attempted
("Cancelled Order safety" below).

**Live-verified — Phase 6B.1**: `orderUpdate`'s real shape differs from
`draftOrderUpdate`'s in exactly one way that matters — it takes a single
`input: OrderInput!` argument; the target Order's GID is a field *inside*
that input (`OrderInput.id`), never a separate top-level mutation
argument. The originally-implemented candidate
(`orderUpdate(id: ID!, input: OrderInput!)`, modeled directly on
`draftOrderUpdate`) was wrong and was rejected outright by Shopify
(`"Field 'orderUpdate' doesn't accept argument 'id'"`) the first time it
was tried live — confirmed via GraphQL schema introspection, then fixed
in `order-mirror.ts` and redeployed to staging before any further live
proof. This is exactly the kind of thing that could not have been known
without live schema access, and is why Phase 6B's tests (which only mock
`fetch` and never validate against Shopify's real schema) passed despite
the bug. **After the fix**, a full live proof round succeeded on staging
against a real synthetic Order (`#1023`) using the real, unmodified
`mirrorRequestedDeliveryDateToOrder()` function: first write added
`requested_delivery_date` while preserving an unrelated seeded attribute;
a second call with a different date replaced the value, still exactly one
key, unrelated attribute still preserved; a third call with the same date
performed the same idempotent read-merge-write again (behavior B from the
Phase 6B.1 brief — it does not special-case "already current" into a
skip, and that is an acceptable, safe outcome). `getOrderForHandoff()` was
also live-proven against the same Order, and `createOrGetOrderDeliveryHandoff()`
was live-proven end-to-end (correct `commerceObjectType`, GIDs,
`publicReference` sourced from the real `Order.name`, idempotent duplicate
create, zero `CustomerProfile` fabrication). See the Phase 6B.1 report for
the full, itemized live-proof results.

## `write_orders` / `read_customers` status (Phase 6B.1 — resolved)

**Production** (`9h7x2c-ku.myshopify.com`): `read_all_orders`,
`read_customers`, `write_draft_orders`, `read_draft_orders`,
`read_orders`, `write_orders` — all present, live-confirmed. No scope
change needed or made.

**Staging** (`stones4u-dev.myshopify.com`): as of Phase 6B.1, live-confirmed
to now also include `read_customers` and `write_orders` (granted between
Phase 6B and Phase 6B.1) — full scope list: `read_customers`,
`write_draft_orders`, `read_draft_orders`, `read_orders`, `write_orders`.
The `order(id) { customer { id } }` query that previously returned
`ACCESS_DENIED` now succeeds with zero errors. Both environments are
fully aligned; no further scope action needed for either.

## Write safety guard

`mirrorRequestedDeliveryDateToOrder()` calls `assertShopifyWriteAllowed()`
as its first line, identical to the Draft mirror — same fail-closed
allowlist check, same "no environment-name branching in code" property, no
new guard mechanism introduced.

## Service abstraction — typed dispatch, not GID-sniffing

Two fully independent functions, not one function with an
`if (gid.includes("DraftOrder"))` branch:

- `createDeliveryDateHandoff()` / `submitRequestedDeliveryDate()` — existing,
  **completely untouched** Draft path. Zero lines changed inside either
  function; every existing test for them still exercises the exact same
  code.
- `createOrGetOrderDeliveryHandoff()` / `submitRequestedDeliveryDateForOrder()`
  — new, parallel Order path.

Choosing which pair to call is a decision a future caller makes based on
the explicit, typed `commerceObjectType` column — never by inspecting a GID
string. Keeping the two paths as separate functions (rather than one
function branching internally) was a deliberate trade-off: it costs a small
amount of duplicated persist/Activity/audit logic, in exchange for
**zero risk** to the already-proven, production-live Draft flow — nothing
in `submitRequestedDeliveryDate()` was touched at all. Phase 6D decides how
the public route(s) wire this dispatch at the edge; Phase 6B only needed
both typed, tested building blocks to exist.

## Order submission behavior

`submitRequestedDeliveryDateForOrder()` mirrors the Draft version's
validate → persist → mirror ordering exactly, but never calls
`resolvePaymentTarget()` and never returns a `redirectUrl` — its result
type is `{ requestedDeliveryDate: string }` only. This is the concrete
expression of the "payment ≠ order ≠ invoice ≠ delivery" requirement: an
Order-based submission has no payment-provider dependency anywhere in its
code path, not even a `paymentProvider` value to branch on (new
Order-based rows are created with `paymentProvider: UNKNOWN`, which the
Draft-only `resolvePaymentTarget()` would fail closed on if it were ever
mistakenly called for one — it never is).

## Cancelled Order safety

Checked inside `mirrorRequestedDeliveryDateToOrder()` itself, as part of
the same read used for the merge: if `cancelledAt` is set, the function
throws before attempting any mutation. This means a cancelled Order can
never receive a customAttribute write via this path, and the caller
(`submitRequestedDeliveryDateForOrder()`) surfaces this as the same
retryable, customer-friendly "kon uw leverdatum niet doorgeven" failure
already proven in the Draft flow — no stale-state write, no silent
success.

**Known, accepted race**: there is a small, unavoidable window between the
cancellation read and the `orderUpdate` mutation in which the Order could
theoretically become cancelled in Shopify. This is accepted as-is for this
low-risk preference attribute — no locking/re-verification is introduced
to close it, which would be overengineering for a non-financial,
non-binding customer preference. A future webhook-driven flow (Phase 6C+)
may additionally close/invalidate a handoff on an `orders/cancelled`
event, but that is out of scope here.

## Activity behavior

Unchanged rule, reused verbatim: `DELIVERY_DATE_REQUESTED` is written only
on a genuinely new or changed `requestedDeliveryDate` (never on a
same-date resubmit, never on create, never on token regenerate, never on a
plain GET) — proven by dedicated tests for the Order path exactly matching
the existing Draft-path tests.

## B2B / concept-order boundary

Grepped the new code (`order-mirror.ts`, `order-for-handoff.ts`,
`delivery-handoff.service.ts`) for `financialStatus`/`displayFinancialStatus`/
`PAID` — zero matches. No new code path treats payment status as a
precondition for a handoff to exist, be created, or be mirrored.

## Security review (delta from Phase 6A's threat model)

- No raw token persistence/logging — unchanged, same `token.ts` mechanism
  reused for Order-based rows.
- No client-supplied Order GID reaches a public POST — `createOrGetOrderDeliveryHandoff()`
  is not called from any route in this phase.
- No arbitrary redirects — the Order path has no redirect at all.
- No host-header URL construction — this phase adds no new URL-building
  code; `publicReference` is a display string, never used to build a URL.
- Write guard is the first call in `mirrorRequestedDeliveryDateToOrder()`.
- Exact Shopify shop binding — unchanged, reused `assertShopifyWriteAllowed()`.
- `publicReference` never carries PII — sourced only from `order.name`.
- Customer-profile linking stays server-side only — `createOrGetOrderDeliveryHandoff()`
  accepts a resolved `customerProfileId`, never fabricates one, never
  accepts a Shopify customer GID and resolves it internally in this
  phase (that resolution step is identical to the existing
  `resolveCustomerProfileIdForShopifyGid()` and is reused, not
  reimplemented, whenever a caller wires this up).

## Tests added

- `tests/order-mirror.test.ts` (8 tests) — write-allowlist enforcement,
  attribute add/preserve/replace/de-duplicate, idempotent resubmit,
  `userErrors` failure, missing-Order failure, cancelled-Order refusal.
- `tests/delivery-handoff-shopify.test.ts` — 4 new tests for
  `getOrderForHandoff()` (read-only proof, field mapping, cancelled/
  customer/shipping-address mapping, unknown-Order → null).
- `tests/delivery-handoff.test.ts` — 12 new tests: Order-handoff creation
  shape, historical-Draft-row default, idempotent create, Draft/Order
  non-collision, no-CustomerProfile-fabrication, MIRRORED-with-no-redirect,
  mirror-failure-stays-retryable, invalid-date-never-mirrors, Activity
  first/changed/same-date behavior, data-integrity guard for a missing
  `shopifyOrderGid`.

All existing Draft-flow tests pass unchanged — see full-suite result in
the Phase 6B foundation report.

## Live-proof status summary (Phase 6B.1, exact)

- **Production**: `read_customers` and `write_orders` are both active
  (live-confirmed). **No production Order has ever been mutated by this
  feature** — every live-write proof in Phase 6B.1 ran exclusively against
  `stones4u-control-center-staging` / `stones4u-dev.myshopify.com`.
- **Staging**: `read_customers` and `write_orders` are both active
  (live-confirmed, granted between Phase 6B and 6B.1).
- **Verified live** (staging only): `Order` read, `Order.customer` read,
  the `orderUpdate` mutation shape (`input: OrderInput!` with `id` nested
  inside), attribute preservation across multiple writes, date replacement
  across multiple writes.
- **Verified live, current behavior** (not changed to force a different
  outcome): re-mirroring an already-current date performs the same safe,
  idempotent read-merge-write again rather than skipping.
- **Synthetic Order `#1023`** (`gid://shopify/Order/13299205374297`) on
  `stones4u-dev.myshopify.com` is **test-only** — no real customer, no real
  payment, no fulfillment, clearly marked in its note/line-item text. It
  could not be deleted (Shopify does not support deleting a completed
  Order) and remains in the dev store, visibly marked as test data.
- **OfferteApp**: no involvement anywhere in Phase 6B or 6B.1 — never
  opened, read, called, or deployed.

## Webhook intake (Phase 6C)

### Verified Shopify webhook requirements

Confirmed via Shopify's own current documentation (fetched live during this
phase, not recalled from memory) plus live GraphQL introspection against
`stones4u-dev.myshopify.com`:

- Topic: `ORDERS_CREATE` exists in the live `WebhookSubscriptionTopic`
  enum (confirmed alongside `ORDERS_CANCELLED`, for a possible future
  phase).
- `webhookSubscriptionCreate(topic: WebhookSubscriptionTopic!,
  webhookSubscription: WebhookSubscriptionInput!)` — live-confirmed
  argument names (`topic` + `webhookSubscription`, **not** a generic
  `input`). `WebhookSubscriptionInput` fields: `format`, `includeFields`,
  `filter`, `metafieldNamespaces`, `metafields`, `name`, `uri` (`uri` is
  the callback URL).
- HTTP delivery headers (Shopify's webhook documentation):
  `X-Shopify-Topic`, `X-Shopify-Hmac-Sha256` (base64-encoded HMAC-SHA256
  of the raw body), `X-Shopify-Shop-Domain`, `X-Shopify-API-Version`,
  `X-Shopify-Webhook-Id` (the documented deduplication key),
  `X-Shopify-Triggered-At`, `X-Shopify-Event-Id`.
- Retry behavior: up to 8 retries over 4 hours on no response or a
  non-2xx (3xx included) response; a `200` acknowledges success.
- **Live-confirmed** (documentation alone did not settle this): a real
  Shopify webhook delivery to the staging endpoint sent
  `X-Shopify-Topic: orders/create` — REST-style, lowercase with a slash,
  **not** `ORDERS_CREATE` — even though the subscription was registered
  via the GraphQL `ORDERS_CREATE` enum value. The route still accepts
  both variants defensively, but the real, observed value is
  `orders/create`.

### Webhook secret authority

Live-verified via Shopify's documentation: webhook HMAC verification
"uses your app's client secret as the key" — no distinction made for a
client-credentials custom app, and this repo's `SHOPIFY_CLIENT_SECRET` is
exactly that credential. **No new `SHOPIFY_WEBHOOK_SECRET` env var was
introduced** — reusing the existing, already-required, already
production/staging-isolated `SHOPIFY_CLIENT_SECRET` avoids a second name
for the same value that could drift out of sync. Verification fails
closed if the secret is unset.

### HMAC verification

`src/integrations/shopify/webhook-verify.ts` — `verifyShopifyWebhookHmac(rawBody, hmacHeader)`.
Computes HMAC-SHA256 over the *exact raw request body string* (never a
re-parsed/re-serialized version — `request.text()` is captured before any
`JSON.parse`), base64-decodes the header, length-checks before comparing
(an unequal length can never be valid and would otherwise leak timing
information through `timingSafeEqual`'s own length assertion), and
compares with `crypto.timingSafeEqual`. Missing secret or missing header →
reject.

### Shop identity

`src/integrations/shopify/webhook-shop-identity.ts` —
`isExpectedWebhookShopDomain()`. A pure, local, case-insensitive exact-match
comparison of the `X-Shopify-Shop-Domain` header against
`SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN` — deliberately **not** a live Shopify
call (unlike `assertShopifyShopIdentity()` in `guard.ts`, which verifies
*outbound* write identity). Runs only after HMAC verification succeeds —
Shopify's webhook HMAC covers the body only, never headers, so this check
remains meaningful defense-in-depth even post-HMAC, not a redundant step.
No subdomain/suffix matching of any kind.

### Idempotency data model

New `ShopifyWebhookEvent` model (additive migration
`20260910060931_phase6c_shopify_webhook_intake` — one new enum, one new
table, one unique index, one plain index; zero changes to any existing
table). Unique on `(shopDomain, webhookId)`, matching Shopify's own stated
purpose for `X-Shopify-Webhook-Id`. `status`: `RECEIVED` → `PROCESSED` (on
full pipeline success) or `FAILED` (any error) — `FAILED` is intentionally
retryable, never a permanent poison record: a redelivery with the same
`(shopDomain, webhookId)` finds the `FAILED` row and is allowed to
reprocess rather than being silently skipped.

**Concurrency safety (added during final review, 2026-09-10)**: the
original find-then-create claim logic had two related gaps under genuinely
simultaneous delivery of the same `(shopDomain, webhookId)` — Shopify's
delivery is at-least-once at the transport level, so this is a real
scenario, not only a theoretical one. First, two requests could both pass
`findUnique` seeing nothing, then race on `create`; the losing `create`
threw an unhandled Prisma `P2002`, propagating to the route's outer catch
and incorrectly marking that delivery `FAILED` (self-healing on Shopify's
own retry, but not actually race-safe). Second, and more commonly: any two
near-simultaneous deliveries — not only the exact-same-instant case — could
both find the same existing `RECEIVED` row (created moments apart, no
exception involved at all) and both proceed into full business processing
concurrently, which is the one thing the claim path exists to prevent.
Fixed in `claimWebhookDelivery()`
(`src/modules/delivery/webhook-receipt.service.ts`) with two changes: (1)
the `create()` call is now wrapped in a catch for `P2002`, re-fetching and
returning the winning row through the same logic below rather than letting
the violation surface as a processing failure; (2) a `RECEIVED` row is now
treated as `skip` (defer — another request is presumed still actively
processing it) while younger than a 30-second in-flight lease window
(`receivedAt`-based, no new column needed), and only treated as `retry`
(safe to take over) once past that window — preserving the original
crash-recovery intent (a `RECEIVED` row stuck forever because a prior
attempt crashed mid-processing must still eventually be retryable) while
closing the concurrent-double-processing gap for the realistic case.
Proven with a real DB-level race in
`tests/webhook-receipt.test.ts` (`Promise.all` of two simultaneous claims
against the same `(shopDomain, webhookId)` — the test log confirms an
actual Postgres unique-constraint collision occurs and is handled, not
merely a theoretical code path), plus dedicated in-flight-lease and
stale-lease-recovery tests. This is a real runtime-behavior change, but it
only affects the internal claim race window — a scenario the prior manual
staging E2E proof below could not exercise (it tested sequential duplicate
delivery against an already-`PROCESSED` row, which was and remains correct
and is unaffected by this fix) — so the existing staging proof's claims
remain accurate as written and were not repeated for this change.

### Endpoint & processing order

`POST /api/webhooks/shopify/orders-create` —
`src/app/api/webhooks/shopify/orders-create/route.ts`. Fixed order, never
reordered: raw body → HMAC → shop identity → topic → idempotency claim →
parse → derive Order GID → live Order re-read (`getOrderForHandoff()`,
read-only) → eligibility → (only if genuinely eligible) handoff creation.
Nothing is persisted at all for a request that fails HMAC, shop-identity,
or topic verification — there is no receipt to dedupe or retry for a
sender that was never proven authentic.

### Trusted Order identifier

The webhook payload's numeric `id` field (Shopify's REST-shaped webhook
JSON, regardless of GraphQL/REST registration) is converted to a GID as
`gid://shopify/Order/<id>` — Shopify's GID format is a stable, documented
platform convention (`gid://shopify/<ResourceType>/<legacy_numeric_id>`),
unlike the `orderUpdate` mutation shape from Phase 6B.1, which needed live
verification. The Order id is read exclusively from the HMAC-verified
payload — a public/client caller has no way to supply an arbitrary Order
GID to this route at all. The payload's `id` is validated as a positive
integer or an all-digit numeric string (`/^[1-9]\d*$/`) before the GID is
constructed — added during final review; the original check only tested
truthiness, which would have silently built a syntactically-plausible but
semantically-wrong GID for any non-numeric `id` (a safe failure in
practice, since `getOrderForHandoff()` would just return `null` for it, but
not an explicit validated-format guard as intended).

### Eligibility engine

`src/modules/delivery/eligibility.ts` —
`evaluateDeliveryDateEligibility(order)`. Deliberately conservative per
this phase's explicit brief: missing an automatic handoff is preferable
to creating one for the wrong Order. Three hard negatives checked in
order (cancelled → already has a requested date → no shipping address),
then an explicit `INSUFFICIENT_CLASSIFICATION` fallback that every real
Order reaches today — **no code path currently returns `eligible: true`**.
This is intentional: Phase 6A discovery's live sample of real production
orders found `tags` empty everywhere and only two ambiguous `sourceName`
patterns, neither trustworthy enough for a positive rule. Source-channel
data was re-examined this phase (no new reliable signal found — see
"Source channel findings" below) and shipping-address presence is treated
only as a negative filter, never a positive eligibility signal, per this
phase's explicit instruction not to treat it as a complete pickup rule.

### Source channel findings (re-examined, Phase 6C)

No new reliable positive signal found beyond what Phase 6A discovery
already established. `tags` remain empty on real sampled orders; the two
observed `sourceName` patterns (`"shopify_draft_order"` and an
unidentified numeric app id) are not confirmed enough to build eligibility
logic on. This remains an explicit, open decision point for Fons (see
blockers).

### Auto-handoff policy

Only `decision.eligible === true` may reach
`createOrGetOrderDeliveryHandoff()` — structurally present in the route
for forward-compatibility, but unreachable by any real Order today given
the eligibility engine above. No email, no Shopify write, anywhere in
this pipeline.

### HTTP response policy

| Situation | Status | Rationale |
|---|---|---|
| Invalid/missing HMAC | 401 | Reject before trusting anything; Shopify's generic retry loop still applies, but the security invariant (never process an unverified payload) matters more than optimizing retry count for a case that, if not an attack, is a real misconfiguration an operator should see and fix |
| Wrong/missing shop domain | 401 | Same reasoning |
| Unexpected/missing topic | 401 | Same reasoning |
| Missing webhook id | 401 | Nothing to dedupe against |
| Malformed JSON / missing or non-numeric Order id (despite valid HMAC) | 400 | Can't be Shopify's own payload — permanent, not retryable |
| Duplicate, already `PROCESSED`, or another request still within the in-flight lease | 200 | Already handled (or being handled) — no reprocessing, still a success from Shopify's perspective |
| Recorded, not eligible | 200 | Correct business outcome — no retry needed |
| Transient error (e.g. Order re-read fails) | 500 | Lets Shopify's built-in retry (up to 8 over 4 hours) resume; `FAILED` status permits reprocessing on redelivery |

No internal error detail is ever included in a response body. (Final review, 2026-09-10: the Order-not-found-on-reread case previously returned `200`/`"recorded"` in the shipped code — inconsistent with this table and with the `FAILED` status it set internally — corrected to `500` so it actually falls into the transient-error/retry-permitting row above, matching what this table already specified.)

### Staging live E2E proof (2026-09-10)

Registered exactly one webhook subscription (`ORDERS_CREATE`) against
`stones4u-dev.myshopify.com`, pointing at the staging endpoint. Created a
synthetic Order (`#1024`, `gid://shopify/Order/13299759120729`, via a
synthetic Draft completed with `paymentPending: true` — no real customer,
payment, or fulfillment). Proved, against the real deployed endpoint:

- **Real Shopify delivery**: arrived, HMAC-verified, shop-identity-verified,
  topic `orders/create` accepted, receipt claimed, Order re-read live,
  classified `NO_SHIPPING_ADDRESS` (correct — this synthetic order has no
  shipping address), `status: PROCESSED`, no handoff created.
- **Duplicate delivery** (crafted, validly-signed, same synthetic
  `X-Shopify-Webhook-Id`): second call returned `{"status":"already
  processed"}` — no reprocessing, receipt count stayed at 1 for that id.
- **Tampered body, stale signature**: `401 unauthorized` — HMAC correctly
  rejected a body that no longer matched its signature.
- **Wrong shop domain** (production's domain, otherwise valid): `401
  unauthorized` — shop-identity check correctly rejected a cross-shop
  attempt.
- **Missing HMAC header**: `401 unauthorized`.
- **Zero Shopify mutations for `requested_delivery_date`**: confirmed via
  a direct read of the Order's `customAttributes` after the entire test —
  empty, exactly as expected for a `NO_SHIPPING_ADDRESS`/not-eligible
  outcome.
- **Zero DeliveryDateHandoff rows created** at any point (confirmed via a
  direct count — stayed `0` throughout).

Cleanup: both `ShopifyWebhookEvent` rows deleted, the webhook subscription
unregistered, the synthetic Order cancelled (`refund: false` — no payment
was ever captured, so there was nothing to refund; not a payment/refund
flow, a pure state cleanup).

## Post-order public UX (Phase 6D)

The public `/delivery/[token]` flow now serves two fully separate
experiences from one route, dispatched exclusively by the handoff's own
persisted `commerceObjectType` — never a client-supplied value, a GID
sniff, or a query param. `SHOPIFY_DRAFT_ORDER` keeps the original,
byte-for-byte unmodified checkout-oriented experience (`DeliveryDateForm`,
`submitRequestedDeliveryDate`, unchanged Mollie/invoice-redirect
semantics). `SHOPIFY_ORDER` renders a dedicated post-order experience
(`OrderDeliveryDateForm`) that never shows payment/checkout copy and never
redirects — a successful submission replaces the form in place with an
in-page "Bedankt!" success state showing the chosen date in Dutch
(`formatDateLong()`, full month name, `Europe/Amsterdam`). An unrecognized
`commerceObjectType` fails closed (404 on the page, a generic 500 on the
POST route) rather than guessing.

The POST route now returns a discriminated union
(`src/modules/delivery/submit-response.ts`): `{outcome:"REDIRECT",
redirectUrl}` for Draft, `{outcome:"COMPLETED", requestedDeliveryDate}` for
Order — the Order shape structurally has no `redirectUrl` field at all, so
there is no redirect authority to accidentally exercise on that path. The
client branches only on the server-declared `outcome`, never on field
presence.

**Cancelled-Order semantics**: a new `OrderCancelledError` (distinct from
the generic `ShopifyApiError`) lets `submitRequestedDeliveryDateForOrder()`
tell "this Order is permanently cancelled" apart from a transient mirror
failure. Either way, `status` is set to `ERROR` — never `MIRRORED` —
*before* the error-type check runs, and the `MIRRORED` update later in the
function is only reachable if the mirror call actually succeeded; a
cancelled-Order submission structurally cannot leave the row looking
successfully mirrored. The customer's locally persisted
`requestedDeliveryDate` remains exactly what the existing `ERROR` status
already means ("the most recent mirror attempt failed; requestedDeliveryDate
is safely persisted locally regardless" — see the enum's own comment in
schema.prisma) — a historical attempted preference, not a confirmed one.
The customer sees "Deze bestelling is geannuleerd." and no success state.

### Staging live E2E proof (2026-09-10, staging v41)

Created a synthetic Order (`#1025`) via a custom, non-catalog draft-order
line item (this app's OAuth scope has no `read_products`, discovered live)
completed with no payment gateway, then created an Order handoff with the
real, deployed `createOrGetOrderDeliveryHandoff()`. Proved, against the
real deployed endpoints:

- **Public page**: `200`, the Order-specific heading/context copy present,
  `#1025` rendered as the public reference, zero payment-step copy, zero
  Shopify GID exposed.
- **First submit**: real `POST`, `200`, `{outcome:"COMPLETED",
  requestedDeliveryDate:"2026-09-20"}`, no `redirectUrl` key in the
  response at all.
- **Order `customAttributes`**: exactly one `requested_delivery_date`,
  value `2026-09-20`.
- **Date change**: a second real submit changed the value to
  `2026-09-30` — attribute count stayed at exactly one throughout, never
  two.
- **Activity**: `0` at every step — this synthetic handoff was created
  without a linked `CustomerProfile` (deliberately, to avoid fabricating
  one), so this proves the "no linked profile → no Activity" path live; the
  "changed date → new Activity / same date → no duplicate" rule for a
  *linked* profile is proven at the service-layer level in
  `tests/delivery-handoff.test.ts` and was untouched this phase.
- **Cleanup**: the Order was cancelled (`orderCancel`, no refund, no
  restock, no customer notification — confirmed `cancelledAt` set
  afterward) and the CRM handoff row deleted. One honest observation: the
  completed Order showed `displayFinancialStatus: PAID` despite no payment
  gateway ever being supplied to `draftOrderComplete` — this store appears
  to default a gateway-less completion to paid; no payment-collection call
  was made by any script.
- **Production**: zero mutations, zero deploys. **OfferteApp**: not
  touched.

## Next phase boundary (Phase 6E and onward)

Explicitly **not** built in Phase 6C or 6D: notification outbox, any
provider integration, any transactional mail, a staff UI for creating
Order-based handoffs (today only reachable via the unreachable webhook
eligibility path or ad-hoc test tooling), a positive eligibility rule,
production webhook registration. Per the Phase 6A discovery artifact's
phased plan: 6E notification outbox; 6F manual staff fallback; 6G full
staging E2E including the customer-facing form; 6H production readiness;
6I production canary.

## Open decisions for Fons (unchanged from Phase 6A, still unresolved)

1. Notification-send provider (Microsoft Graph `Mail.Send` vs. a
   dedicated transactional provider vs. staff-manual-only at first).
2. Identity of the unconfirmed `sourceName` app id seen in production
   order samples (Phase 6A) — would materially strengthen the eligibility
   engine if resolved.
3. Whether OfferteApp/Kassa Systeem should be asked (as separate, later
   tasks in those repos) to stamp a recognizable tag/attribute on orders
   they create, to give Phase 6D+ a trustworthy positive eligibility
   signal.
4. Token-expiry policy (Phase 6A recommended none — unchanged).
5. **New this phase**: whether/when to register the `ORDERS_CREATE`
   webhook on **production** — deliberately not done in Phase 6C (staging
   only, per this phase's hard boundary).
