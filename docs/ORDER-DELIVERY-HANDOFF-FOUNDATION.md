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

## Staff Order handoff management (Phase 6E)

`/delivery-handoffs` now has an "Orders" / "Draft Orders" tab (Orders
default), letting staff search real Shopify Orders — not only Draft
Orders — and create a delivery-date link for one. This is the safe manual
fallback ahead of any automatic eligibility/notification path.

`searchOrdersForHandoff()` (`src/integrations/shopify/order-search.ts`) is
a minimal, separate search query — never returns customer name, email,
phone, or full address, only the customer GID (server-side matching only)
and enough context to show staff a sensible result (cancelled state,
fulfillment status, and — see below — the actual `requested_delivery_date`
value when one already exists).

`createOrderDeliveryHandoffForStaff()`
(`src/modules/delivery/delivery-handoff.service.ts`) is the only path
that may call the proven `createOrGetOrderDeliveryHandoff()` from a staff
action. It accepts only the selected Order's GID (plus the narrow
confirmation flag described below) and always re-reads that specific
Order fresh via `getOrderForHandoff()` immediately before creating — a
search result can be stale by the time staff acts on it (another tab,
another staff member, time passing), so `publicReference`, cancellation
state, and the customer GID used for matching are all derived from *that*
re-read, never from the client or a cached search result. A cancelled
Order is refused with a staff-friendly, non-retryable error; an already
existing local handoff is always the ordinary idempotent path (same row,
no new token on a repeat call).

### Requested-delivery-date provenance (clarified business rule, this round)

**`requested_delivery_date` is not exclusively portal-generated.** Fons
clarified this round: Stones4U staff may already agree a delivery date
with a customer *before* payment and *before* a real Shopify Order even
exists — during quote/offer preparation, on the Draft Order. The intended
future flow:

```
Offerte / Draft Order
        ↓
requested_delivery_date may already be entered
        ↓
Draft becomes a real Shopify Order (existing, proven propagation)
        ↓
requested_delivery_date survives onto the Order
        ↓
customer pays
        ↓
Control Center checks: is requested_delivery_date already known?
        ↓
   YES → do not send another "Wanneer mogen we langskomen?" request
   NO  → if otherwise eligible and the payment condition is met,
         send the customer a delivery-date request
```

Possible future origins of a `requested_delivery_date` value include
`QUOTE`, `CUSTOMER_PORTAL`, `STAFF_MANUAL`, `B2B`/`ON_ACCOUNT`, and
`UNKNOWN_LEGACY` (any pre-existing value with no recorded source). **None
of this is implemented in Phase 6E** — no OfferteApp integration, no quote
UI field, no provenance column. What 6E *does* do is make sure nothing
built so far — nor anything built later on this foundation — bakes in the
wrong assumption.

**What changed in the staff Order-creation path because of this**:
discovering an existing `requested_delivery_date` on a fresh Shopify
re-read, with no local handoff yet for that Order, is no longer silently
ignored (nor silently overwritten). `createOrderDeliveryHandoffForStaff()`
now throws a typed `ExistingRequestedDeliveryDateError` (carrying only the
date value) unless the caller explicitly passes
`confirmExistingRequestedDeliveryDate: true`. The staff API route maps
this to `409 {code: "EXISTING_REQUESTED_DELIVERY_DATE",
requestedDeliveryDate}`; the UI shows a confirmation dialog ("Gewenste
leverdatum al bekend" — "Voor deze bestelling is al een gewenste
leverdatum van *[datum]* geregistreerd. Wilt u de klant opnieuw vragen een
gewenste leverdatum door te geven?" — Annuleren / Toch nieuwe link maken).
The wording deliberately says "geregistreerd"/"bekend", never "door de
klant doorgegeven" — provenance is not known, and must never be
presented as known.

This confirmation requirement applies **only** to a first handoff for the
Order. An existing local handoff always takes the normal idempotent path
regardless of what Shopify currently shows — a customer who already used
their link, with staff later revisiting management, must never be asked
to "confirm" anything just because the date they already submitted is,
unsurprisingly, still on the Order. **Cancellation still wins over an
explicit confirmation** — a cancelled Order can never get a new handoff,
confirmed or not.

**Data model**: no migration was needed. `getOrderForHandoff()` gained an
additive `requestedDeliveryDate: string | null` field (alongside the
existing, unchanged `hasRequestedDeliveryDateAlready: boolean`, which
`eligibility.ts` and the webhook route still depend on exactly as before —
neither was touched). The *value* lives on `requestedDeliveryDate`;
*where it came from* is deliberately not tracked yet, and is never
inferred from whether a local `DeliveryDateHandoff` exists (a Shopify date
with no local handoff is common and expected under the future quote flow,
not an anomaly). When real provenance tracking is needed, the clean,
non-destructive shape is a new nullable enum column (`QUOTE` /
`CUSTOMER_PORTAL` / `STAFF_MANUAL` / `B2B` / `UNKNOWN_LEGACY`) tracked
*separately* from the date value itself — never encoded into the date
string, never fabricated for historical rows (which must default to
`UNKNOWN_LEGACY`, not guessed).

**Activity/audit**: discovering an existing Shopify date is not the same
event as a customer submitting one through the portal, and no code path
in the staff creation flow creates a `DELIVERY_DATE_REQUESTED` Activity —
that Activity type is, and remains, created only by the actual public
submit functions (`submitRequestedDeliveryDate` /
`submitRequestedDeliveryDateForOrder`), unchanged this round. Future
provenance/audit work should be able to distinguish "entered during quote",
"staff manually entered", "customer submitted via portal", and "date
changed later" — none of that exists yet, and this round does not
fabricate any of it to fill the gap.

**Eligibility engine reinterpretation (no code change)**: `eligibility.ts`
itself is untouched this round (build instruction §18), but its
`ALREADY_HAS_REQUESTED_DELIVERY_DATE` reason must now be read as a general
business exclusion — "Stones4U already knows a requested delivery date,
regardless of source" — not a portal-specific dedupe check. This is the
rule that will eventually suppress an automatic delivery-date request:

```
Order created → customer pays → Control Center evaluates
        ↓
FIRST CHECK: does the Order already have requested_delivery_date?
   YES → stop, no automatic request, no email
   NO  → continue: regular customer? delivery Order? not cancelled?
         payment condition satisfied? → create handoff, queue
         notification (not built yet)
```

`ORDERS_CREATE` itself must never be read as "send the customer an
email" — payment is an additional condition for the normal
consumer/quote flow, not implied by order creation alone. **B2B/on-account
customers are the explicit exception**: for those, payment may never be
the trigger at all (goods on account, concept orders, later bundled
invoicing) — Order, payment, invoice, and delivery must remain four
independent concepts, never conflated. The one rule that stays constant
across both: if a requested delivery date is already known, do not ask
again unnecessarily. None of the payment-trigger or B2B logic is built in
Phase 6E — this section is architecture documentation only.

### Test hygiene note (Phase 6E live staff E2E)

During the Phase 6E live staff E2E, two synthetic-credential values were
briefly printed to tool output instead of only ever being redirected to a
file: the throwaway test staff account's session cookie (via a `curl -i`
call), and the raw public token embedded in a handoff-creation response.
Both were caught immediately, both belonged only to synthetic staging test
rows, and both were fully invalidated as part of the same round's cleanup
(the session by deleting its user, the token by deleting the handoff row)
— no production credential was ever involved. Process fix, no new tooling
needed: any future live test whose response can embed a token, session
cookie, or Authorization value must capture that response to a local file
(`curl -o`) rather than print it, and only ever print values derived from
it (status codes, booleans, non-secret fields).

## Payment trigger & delivery request decision engine (Phase 6F)

### Verified payment event (build instruction §3)

Live-introspected against this API version's schema (never assumed):
`ORDERS_PAID` exists in `WebhookSubscriptionTopic`, alongside
`ORDERS_CANCELLED`/`ORDERS_CREATE`/`ORDERS_UPDATED`/`ORDERS_FULFILLED`/
`ORDERS_PARTIALLY_FULFILLED`/etc. — the REST-style header value is
`orders/paid`, mirroring the `orders/create` vs `ORDERS_CREATE` duality
already confirmed for the first webhook in Phase 6C, so both spellings are
accepted defensively here too. Payload shape and Order-id availability are
identical to `orders/create` (a numeric `id`) — the same trusted-id
derivation and canonical re-read apply unchanged. Retry semantics are
Shopify's standard webhook contract (up to 8 attempts over 4 hours on a
non-2xx response) — nothing payment-specific there. An Order created
already paid still fires `ORDERS_CREATE` once and `ORDERS_PAID` once (two
separate deliveries, handled identically by the shared idempotency layer);
a Draft-to-Order completion is indistinguishable from any other Order
creation at the webhook level.

### Canonical payment-state field (build instruction §7)

`Order.fullyPaid: Boolean` — live-introspected alongside several other
candidates (`displayFinancialStatus`, `totalOutstandingSet`,
`paymentCollectionDetails`, `netPaymentSet`, `unpaid`). `fullyPaid` is the
minimal, direct answer to the one question this feature ever needs
("is the regular-customer payment condition currently satisfied?") without
fetching any amount, gateway name, or payment-method detail. The webhook
is only ever a wake-up signal; `fullyPaid` is read fresh from the Order on
every evaluation, never inferred from which webhook happened to arrive.

### Technical event vs. business decision (build instruction §4)

`ORDERS_CREATE` and `ORDERS_PAID` are **technical events** — "an Order now
exists" / "this Order's payment state may have changed". Neither means
"create a handoff" or "send an email"; each is only a trigger to
re-evaluate the Order's current state via one shared function,
`evaluateDeliveryRequestDecision()` (`src/modules/delivery/
delivery-request-decision.ts`), which returns the **business decision**:
`{ shouldRequest: boolean, reason: DeliveryRequestDecisionReason, trigger }`.
No loose booleans are scattered through the webhook handlers — every
route calls this one function and persists exactly what it returns.

Priority order (build instruction §6), composing the existing Phase 6C
eligibility engine rather than duplicating it:

1. `ORDER_CANCELLED` — never, regardless of payment.
2. `ALREADY_HAS_REQUESTED_DELIVERY_DATE` — never, **regardless of
   provenance** (quote, Draft, staff, portal, B2B, unattributed legacy —
   see Phase 6E's own provenance section above, unchanged this round).
3. `NO_SHIPPING_ADDRESS` — a reliable negative.
4. `MANUAL_ONLY_POLICY` — a policy that never asks automatically.
5. `WAITING_FOR_PAYMENT` — the policy's payment precondition isn't met yet
   (only `REGULAR_CONSUMER` has one; see below).
6. `INSUFFICIENT_CLASSIFICATION` — the conservative default; every real
   Order still lands here today, same as Phase 6C/6E. Shipping-address
   presence is still never sufficient on its own for `shouldRequest: true`
   (build instruction §16) — a paid Order with an address and no date is
   still `INSUFFICIENT_CLASSIFICATION`, not a false positive.
7. `READY_FOR_DELIVERY_REQUEST` — only reachable once a real positive
   classification signal exists; still unreachable today.

### `ORDERS_CREATE` / `ORDERS_PAID` relationship (build instruction §10)

```
ORDERS_CREATE:  requested date absent, regular flow, not paid
                → WAITING_FOR_PAYMENT

  (later)       staff/quote enters requested_delivery_date, OR
                customer pays — either way, re-evaluation happens on
                the next event, always against a fresh Shopify read

ORDERS_PAID:    requested date still absent, paid, but no trustworthy
                positive classification signal exists yet
                → INSUFFICIENT_CLASSIFICATION (not READY — see below)
```

Both routes (`src/app/api/webhooks/shopify/orders-create/route.ts`,
`.../orders-paid/route.ts`) are now thin wrappers around two shared
modules — `intakeShopifyOrderWebhook()` (HMAC → shop identity → topic →
webhook id → idempotency claim → payload parse → trusted Order id) and
`processOrderWebhookEvent()` (canonical re-read → decision → persist) —
differing only in their expected topic set and the `trigger` they record.
This is the reuse build instruction §2 asked for: one implementation of
the security/receipt path, not duplicated per topic.

### Requested-date-before-payment scenarios (build instructions §11, §12)

Both proven by dedicated tests (`tests/order-webhook-processing.test.ts`)
and live on staging (below): a quote/Draft-stage date that survives onto
the Order is caught by `ORDERS_PAID`'s own canonical re-read and
suppresses the decision exactly the same as a date entered any other way
— and critically, a date added *between* `ORDERS_CREATE` and `ORDERS_PAID`
(e.g. staff enters it manually after the Order exists but before payment)
is still caught, because the re-read is always fresh, never a cache of
whatever `ORDERS_CREATE` saw.

### Regular-customer rule and B2B compatibility (build instructions §13, §20)

`DeliveryCustomerPolicy` is `UNKNOWN` / `REGULAR_CONSUMER` /
`B2B_ON_ACCOUNT` / `MANUAL_ONLY`. **Final review found and fixed a real
safety bug this round**: the original implementation made `policy` an
*optional* argument that silently defaulted to `REGULAR_CONSUMER` when
omitted — meaning every real webhook call today (none passed `policy`
explicitly) was implicitly activating consumer payment semantics for
Orders nobody had actually classified. Concretely, this meant an
unclassified, unpaid B2B/on-account Order would have been reported
`WAITING_FOR_PAYMENT` — a real business Order that has nothing to do with
payment, mislabeled as if payment were the only thing blocking it.

The fix: `policy` is now a **required** argument — TypeScript itself
refuses a call that omits it (chosen deliberately over "optional,
defaults to `UNKNOWN`": a required field is harder for a future caller to
misuse by accident than a default they might not realize they need to
override). `UNKNOWN` is a genuinely distinct, structurally separate value
from `REGULAR_CONSUMER` — the decision function never consults `fullyPaid`
at all for `UNKNOWN` (nor for `MANUAL_ONLY`), so an unpaid, unclassified
Order always lands on `INSUFFICIENT_CLASSIFICATION`, never
`WAITING_FOR_PAYMENT`. Every real webhook caller today passes `UNKNOWN`
explicitly, since no per-Order classification source exists yet — this is
now enforced by the type system, not a convention to remember.

Only `REGULAR_CONSUMER` — and only that policy — gates on `fullyPaid`;
`B2B_ON_ACCOUNT` is proven (unit test, and an integration test through the
real webhook-processing path) to never be rejected merely for being
unpaid. Order, payment, invoice and delivery remain four independent
concepts — none of this phase's code ever equates them. Policy is never
inferred from payment state, shipping-address presence, customer
presence, `sourceName`, or `tags` — only a genuinely trustworthy future
classifier may set anything other than `UNKNOWN`.

### Classification gaps (build instruction §14)

No new investigation was needed this round — Phase 6A/6C/6E already
established, and nothing since has changed, that: `tags` are empty on
real sampled orders; the two observed `sourceName` values are ambiguous;
shipping-address presence is a reliable *negative* filter only, never
positive proof of a genuine delivery order. `fullyPaid` (this round's new
field) does not help classification either — it answers "has payment
happened", not "is this a delivery-bound consumer order". Until a real
signal exists (a tagging convention, a confirmed `sourceName` meaning, an
order-type field), `hasTrustworthyDeliveryOrderClassification()` in
`delivery-request-decision.ts` stays hard-coded `false` — the single place
a future rule gets added.

### Durable state design (build instruction §15)

No new table. The decision is persisted on the existing
`ShopifyWebhookEvent.eligible`/`eligibilityReason` columns (schema.prisma
comment updated to reflect the broadened meaning) — the same "one
technical receipt row, no separate workflow table" design Phase 6C
established, now shared by both topics instead of reserved for one. A
`WAITING_FOR_PAYMENT` outcome on `ORDERS_CREATE` is simply overwritten by
whatever `ORDERS_PAID` (or a later re-delivery) determines next; there is
no multi-row history of an Order's readiness over time, which is an
accepted, deliberate simplicity trade-off for this phase.

### Auto-handoff policy, manual fallback, Activity (build instructions §16, §17, §19)

No handoff is auto-created for any real Order today — `shouldRequest`
cannot yet be `true`. Phase 6E's staff Order handoff management is
untouched and remains the deliberate manual fallback regardless of what
the automatic decision says; an automatic `INSUFFICIENT_CLASSIFICATION` or
`WAITING_FOR_PAYMENT` never blocks a staff member from creating a handoff
by hand where they know better. No new staff UI was added — a readiness
label was judged not clearly useful yet, since nothing today ever reaches
`READY_FOR_DELIVERY_REQUEST` for staff to be informed about. Neither
webhook creates a `DELIVERY_DATE_REQUESTED` Activity or any other
Customer 360-visible record — technical outcomes live only on
`ShopifyWebhookEvent`/`AuditEvent`, proven by a dedicated test.

### Staging live E2E proof (2026-09-10, staging v44)

Registered `ORDERS_PAID` only (never `ORDERS_CREATE`, per this round's
scope — the earlier subscription stays unregistered, matching Phase 6C's
own cleanup policy) against `stones4u-dev.myshopify.com`. Discovery made
during setup: on this dev store, completing a gateway-less draft order
(the same technique Phase 6D/6E/6F all use for a synthetic test Order)
already yields `fullyPaid: true` immediately — so both proofs below are
**real, unprompted `orders/paid` webhook deliveries** that Shopify itself
fired as part of order completion, never a hand-crafted request (the one
explicit ask of build instruction §21). Two synthetic Orders:

- **Normal path** (`#1028`): a fresh synthetic Order, no shipping address.
  The real `orders/paid` webhook arrived (a genuine UUID webhook id), HMAC
  and shop identity verified, claimed exactly once, canonical re-read
  confirmed `fullyPaid: true`, decision persisted as `NO_SHIPPING_ADDRESS`
  — a correctly-suppressed outcome for this order's real shape (checked
  before the payment/classification steps in the priority order). Zero
  handoffs, zero emails.
- **Known-date path** (`#1029`, **critical scenario, build instruction
  §22**): `requested_delivery_date: "2026-09-24"` set on the Draft *before*
  completion, simulating a quote/Draft-stage value surviving onto the
  Order. A second, genuinely distinct real webhook delivery arrived;
  canonical re-read saw the existing date and persisted
  `ALREADY_HAS_REQUESTED_DELIVERY_DATE` — no handoff, no notification, no
  overwrite of the existing Shopify attribute.
- **Duplicate delivery** (build instruction §23): the exact `#1029`
  webhook id was replayed with a freshly, validly HMAC-signed body (signed
  in-process on the container using the real `SHOPIFY_CLIENT_SECRET`,
  which was never logged or printed) — `200 {"status":"already
  processed"}`, no reprocessing, proving the claim keys on
  `(shopDomain, webhookId)` alone and rejects a replay before the body is
  even parsed.

Cleanup: both synthetic Orders cancelled (no refund, no restock, no
customer notification), the `ORDERS_PAID` subscription unregistered and
confirmed empty on read-back, all ephemeral scripts removed from the
container's writable layer. Full mutation accounting is in the Phase 6F
final chat report, not duplicated here to avoid drift between the two.

### Final-review policy fix — staging v45, no new live Shopify proof needed

The `policy`-defaults-to-`REGULAR_CONSUMER` bug (see the corrected
"Regular-customer rule and B2B compatibility" section above) was caught
and fixed in final review, deployed to staging as **v45**. Per this
round's own explicit guidance, no new synthetic paid Order was created to
re-prove already-proven Shopify webhook mechanics (HMAC, shop identity,
idempotency, canonical re-read) that this fix does not touch — those stay
proven by the `#1028`/`#1029` live proof above, which remains accurate
unchanged (`NO_SHIPPING_ADDRESS` and `ALREADY_HAS_REQUESTED_DELIVERY_DATE`
both fire before policy is ever consulted, so neither result depends on
the fix either way). Instead: 767 tests (29 for the decision engine and
webhook processing alone) prove the fix at the source level, and the
deployed v45 artifact was confirmed on staging — without any Shopify
interaction — to genuinely contain it, by inspecting the compiled server
bundle directly (`grep` for the `POLICY_REQUIRES_PAYMENT` map and the
`policy === "UNKNOWN"` branch in `.next/server/chunks/`), not merely
trusting that the deploy pipeline carried the local fix across.

## Fulfillment mode signal verification (Phase 6H)

### Correction to Phase 6G's proposed mapping

Phase 6G's final report proposed collapsing `PICK_UP`/`LOCAL`/`PICKUP_POINT`/
`RETAIL` into a single `PICKUP` bucket. This was wrong and was **not**
implemented. Per Shopify's own documented `DeliveryMethodType` semantics:

- `SHIPPING` — the order is shipped.
- `LOCAL` — the order is delivered using local delivery (a delivery, not a
  pickup).
- `PICK_UP` — the customer picks up the order.
- `PICKUP_POINT` — the order is delivered to a pickup point (distinct from
  both `PICK_UP` and `SHIPPING`).
- `RETAIL` — in-store retail sale, no delivery leg at all.
- `NONE` — no physical delivery needed.

### Scope (build instruction §2)

`read_merchant_managed_fulfillment_orders` was verified as a real, current
Shopify access scope via the official Shopify docs (not assumed from
memory). Staging (`stones4u-control-center-staging`) already had this scope
granted at the start of this phase (confirmed live via
`currentAppInstallation.accessScopes { handle }` self-introspection) — the
brief's conditional STOP branch did not apply. Production was **not**
touched or queried for this scope this round (build instruction §6) — see
"Production read-only follow-up" below.

### Live verification (build instructions §3, §5)

Confirmed live on `stones4u-dev.myshopify.com` (staging):

- `Order.fulfillmentOrders.deliveryMethod.methodType` is readable
  immediately at Order creation (Draft Order → `draftOrderComplete`), before
  fulfillment, and after cancellation (`status: CLOSED`) — no timing gap.
- Every synthetic Order observed (this phase and prior phases) has exactly
  one merchant-managed `FulfillmentOrder`. No split-fulfillment case has
  been observed live; the aggregation rules below are therefore constructed
  and unit-tested, not live-proven.
- **`methodType` is driven by the line item's `requiresShipping: Boolean`
  field, not by the mere presence of a shipping address or shipping line.**
  This was not previously known and is the phase's central finding:
  - A custom line item with a shipping address + a shipping line (with or
    without an arbitrary `shippingRateHandle`) but no `requiresShipping`
    flag → `methodType: "NONE"` (Orders `#1030`, `#1031`).
  - The same setup with `requiresShipping: true` added to the line item →
    `methodType: "SHIPPING"` (Order `#1032`).
  - `requiresShipping: true` alone, with **no** shipping address and **no**
    shipping line at all → still `methodType: "SHIPPING"` (Order `#1033`).
    This shows `SHIPPING` is Shopify's default classification for "this
    order requires physical delivery" whenever no more specific delivery
    mechanism (local delivery, pickup, pickup point) is configured — a
    generic-but-real positive signal, not a false one.
  - Real Stones4U catalog products (genuine Shopify variants) are expected
    to already have `requiresShipping` set correctly via normal product
    configuration, so this mechanism should classify genuine webshop/Draft
    Orders correctly without any special-casing — this is an expectation,
    not yet independently confirmed against a real catalog-product order
    (only custom/ad-hoc line items were used in live experiments, to avoid
    touching real inventory).
- `PICK_UP`, `LOCAL`, `PICKUP_POINT`, and `RETAIL` could **not** be
  triggered live within this round's granted scopes. `deliveryProfiles`
  (the likely path to a real local-delivery/pickup-point rate) returned an
  access-denied error — the missing scope was not identified further and
  was **not** requested, per the explicit instruction not to request scopes
  preemptively. An arbitrary `shippingRateHandle` string (not tied to a
  real configured rate) was accepted by `draftOrderCreate` without
  validation but had no effect on `methodType`. This is a genuine,
  honestly-reported gap, not a forced/simulated result — their mapping
  below is asserted from Shopify's documented semantics (tested in
  `tests/fulfillment-mode.test.ts`), not live-observed.

### Coverage (build instruction §4)

`read_merchant_managed_fulfillment_orders` covers every fulfillment order
observed this phase (all merchant-fulfilled, single-location). No
Stones4U-specific evidence was found this round that any fulfillment order
is third-party-fulfilled — `read_third_party_fulfillment_orders` was not
requested and there is no current reason to believe it is needed. This
should be revisited only if a real coverage gap is actually observed (e.g.
a production Order whose `fulfillmentOrders` connection is empty despite a
known fulfillment having occurred).

### Production read-only follow-up (build instruction §6)

Production (`stones4u-control-center` / `9h7x2c-ku.myshopify.com`) was
**not** touched, queried, or scope-checked this round. Per Phase 6G,
production was already confirmed to lack any fulfillment-order read scope.
To inspect production fulfillment mode in a future phase, production would
need `read_merchant_managed_fulfillment_orders` granted (Fons decides
separately) — no production scope change was made or requested this round.

### Recommended next controlled step (corrected)

Manufacturing every enum value in staging is **not** the goal, and no
`read_locations`-family scope should be requested merely to do so. The
values that matter are the ones real Stones4U Orders actually produce, and
production is where those live. The controlled sequence is:

- **A.** Commit and push Phase 6H (done — this section's own phase).
- **B.** Fons adds **only** `read_merchant_managed_fulfillment_orders` to
  the production Control Center Shopify app. No other scope.
- **C.** Perform a **read-only** production fulfillment-mode verification.
- **D.** Correlate against the real production Orders already characterised
  in Phase 6G: delivery-like `shippingLines`, pickup-like "Ophalen" Orders,
  POS Orders, Draft-created Orders, and an OfferteApp-created Order if one
  is present.
- **E.** Observe the actual `DeliveryMethodType` values those Orders carry.
- **F.** No production mutations of any kind.

Only if a genuinely relevant production Order then remains inaccessible —
and the exact reason is proven, not guessed — should any further Shopify
scope be requested.

### `source2pos` attribution (build instruction §7)

`attribution.handle === "source2pos-production"` remains **not** hardcoded
as a `NOT_DELIVERY` signal. No POS-shaped live Order was created this round
(would require production or a staging POS-equivalent order source, neither
available/appropriate this round), so whether `DeliveryMethodType`
naturally classifies POS-attributed orders (as `RETAIL`, `NONE`, or
`PICK_UP`) is unconfirmed. `FulfillmentMode` (the Shopify-native read)
remains the preferred authority once confirmed; attribution stays a
possible future fallback only, never the primary classifier.

### Target internal model (build instruction §8)

Implemented as the smallest possible additive foundation, mirroring exactly
how `fullyPaid` was added in Phase 6F:

- `src/integrations/shopify/fulfillment-mode.ts` — `ShopifyDeliveryMethodType`,
  `FulfillmentMode` (`DELIVERY | CUSTOMER_PICKUP | PICKUP_POINT | RETAIL |
  NONE | UNKNOWN`), and the pure `classifyFulfillmentMode()` mapping
  function per the corrected table above. Lives in `integrations/shopify`
  rather than `modules/delivery` because `order-for-handoff.ts` (an
  integrations-layer file) needs to call it, and this repo's module
  boundary forbids integrations depending on modules.
- `getOrderForHandoff()` now also queries `fulfillmentOrders(first: 50) {
  pageInfo { hasNextPage } edges { node { deliveryMethod { methodType } } } }`
  and exposes a derived `fulfillmentMode: FulfillmentMode` field on
  `OrderForHandoffResult`.
- No database migration — this is a derived, always-fresh read, same as
  `fullyPaid`.

### Multiple FulfillmentOrders (aggregation semantics)

An Order can legitimately carry several FulfillmentOrders (split
fulfillment across locations). `aggregateFulfillmentMode()` therefore
classifies over **all** of them, deterministically, rather than trusting
the first edge:

1. The connection was truncated (`pageInfo.hasNextPage`) → `UNKNOWN`,
   whatever the visible FulfillmentOrders say — an unseen one could
   disagree.
2. No FulfillmentOrders at all → `UNKNOWN`.
3. All FulfillmentOrders agree on one mode → that mode. Agreement is judged
   on the mapped `FulfillmentMode`, not the raw Shopify value, so an Order
   split across `SHIPPING` and `LOCAL` agrees on `DELIVERY` and stays
   `DELIVERY`.
4. Any disagreement → `UNKNOWN`. A FulfillmentOrder with no
   `deliveryMethod` maps to `UNKNOWN` and so disagrees with any classified
   sibling — the intended conservative outcome.

Rule 4 is the one that matters for the future decision engine: a
part-shipped/part-collected Order must never read as a plain `DELIVERY` and
so must never receive an automatic delivery-date request. `first: 50` is far
beyond any realistic Stones4U Order, and rule 1 means exceeding it fails
safe rather than silently classifying on a partial view.

### Access failure / missing scope (no unsafe fallback)

If the fulfillment-order scope is absent, Shopify answers the query with a
GraphQL `errors` array. `shopifyGraphQL()` throws `ShopifyApiError` whenever
`errors` is non-empty (`src/integrations/shopify/client.ts`), before any
`data` is inspected — so `getOrderForHandoff()` fails outright rather than
returning a result with a guessed `fulfillmentMode`. Failing the whole read
is the existing service contract for every Shopify read failure in this
module, and is conservative by construction: no handoff is created and
nothing is sent. `fulfillmentMode` is **never** inferred from
`shippingAddress`, `shippingLines`, shipping-title substrings, `tags`, or
`sourceName` — the only authority is
`Order → fulfillmentOrders → deliveryMethod → methodType`.

### Decision-engine implications (build instruction §9 — conceptual only, not reachable)

The following rule is documented here as the intended shape of a future
extension to `evaluateDeliveryRequestDecision()` — **it is not implemented
as reachable code this round**, and `hasTrustworthyDeliveryOrderClassification()`
remains hard-coded `false`:

1. Cancelled → no request (existing rule, unchanged).
2. `requested_delivery_date` already known → no request (existing rule,
   unchanged).
3. `fulfillmentMode === "UNKNOWN"` → `INSUFFICIENT_CLASSIFICATION`.
4. `fulfillmentMode` is `CUSTOMER_PICKUP`, `PICKUP_POINT`, `RETAIL`, or
   `NONE` → a reliable negative (`NOT_DELIVERY` — no reason to introduce a
   new outcome value for this until the rule is actually wired in).
5. `fulfillmentMode === "DELIVERY"` and `policy === "UNKNOWN"` →
   `INSUFFICIENT_CLASSIFICATION` (existing rule already does this,
   unchanged).
6. `fulfillmentMode === "DELIVERY"` and `policy === "REGULAR_CONSUMER"` and
   unpaid → `WAITING_FOR_PAYMENT` (existing rule, unchanged); paid → future
   `READY_FOR_DELIVERY_REQUEST` once `hasTrustworthyDeliveryOrderClassification()`
   is allowed to consult `fulfillmentMode` — a real, positive signal that
   did not exist before this phase, but deliberately not turned on yet
   (build instruction §16's "keep `READY` unreachable" boundary, reaffirmed
   this round).
7. `fulfillmentMode === "DELIVERY"` and `policy === "B2B_ON_ACCOUNT"` →
   separate B2B trigger/policy (unchanged, still undesigned).

### Tests

`tests/fulfillment-mode.test.ts` — pure mapping tests for all six Shopify
`DeliveryMethodType` values plus missing (`null`/`undefined`) and an
unrecognized future value, all mapping to `UNKNOWN`. Includes the explicit
regression test required by build instruction §11: **`LOCAL` → `DELIVERY`**,
proving Phase 6G's proposed `LOCAL` → `CUSTOMER_PICKUP` mapping is not
present, and that `PICKUP_POINT` stays distinct from `CUSTOMER_PICKUP`. The
same file covers the aggregation rules: `DELIVERY + DELIVERY`,
`SHIPPING + LOCAL` (still `DELIVERY`), `PICK_UP + PICK_UP`,
`DELIVERY + PICK_UP` → `UNKNOWN`, conflicting non-delivery modes →
`UNKNOWN`, a classified sibling alongside one with no `deliveryMethod` →
`UNKNOWN`, empty → `UNKNOWN`, and both truncated-connection cases →
`UNKNOWN`.

`tests/delivery-handoff-shopify.test.ts` proves the field is correctly wired
end-to-end through `getOrderForHandoff()`: a missing-`fulfillmentOrders`
case → `UNKNOWN`, a `LOCAL` case → `DELIVERY`, a split
`SHIPPING + PICK_UP` Order → `UNKNOWN`, and a truncated connection →
`UNKNOWN`. Its existing GraphQL-shaped mock fixtures were updated to include
the new `fulfillmentOrders` field so they do not throw on the added query
field.

### Quote / payment / invoice independence (business rule, documented only)

Recorded here so a later phase does not conflate three separate flows. None
of this is implemented in Phase 6H.

- A quote may already carry a `requested_delivery_date`. That value is
  authoritative wherever it came from (see "Requested-delivery-date
  provenance" above).
- When the customer pays, **Shopify's own invoice/factuur communication
  continues normally and is entirely unchanged**. Control Center neither
  sends, suppresses, replaces, nor participates in it.
- Control Center's delivery-date communication is **additional and
  independent**. Payment is a trigger for Control Center to *re-evaluate*,
  nothing more:
  - `requested_delivery_date` already known → no extra delivery-date
    request. Stones4U never asks a question it already has the answer to.
  - absent, and the Order is an eligible `DELIVERY` → only then may a
    separate "Wanneer mogen we langskomen?" message be sent, in some later
    phase, once `READY_FOR_DELIVERY_REQUEST` is genuinely reachable.

No invoice behavior, no email behavior, and no send-side logic of any kind
was implemented this round.

### No email/handoff automation (build instruction §10)

Confirmed: no outbox, no provider integration, no `DeliveryDateHandoff`
automation, no `requested_delivery_date` write, no production mutation, no
OfferteApp interaction this round. Signal verification and typed foundation
only.

## Stones4U fulfillment contract (Phase 6K)

### Why an explicit signal was needed — Phase 6I production evidence

A read-only verification against 400 real production Orders
(`9h7x2c-ku.myshopify.com`, 2026-04-13 → 2026-09-10) established that
Shopify's own `DeliveryMethodType` describes how *Shopify* is configured,
not what Stones4U is actually doing:

- **Native `SHIPPING` cannot be trusted as positive evidence of delivery.**
  29 genuinely-collected Orders ("Ophalen — Ophalen magazijn Beringe")
  produced native `SHIPPING`, because staff type a free-text shipping line
  instead of using Shopify's native local-pickup mechanism, and `SHIPPING`
  is simply Shopify's default for "these line items are physical goods"
  (root cause proven on staging in 6H: `methodType` follows the line item's
  `requiresShipping` flag). **26 of those 29 were paid** — acting on the
  native signal would have asked 26 customers when to deliver goods they
  were collecting themselves. All 29 carried a shipping address, so the
  existing `NO_SHIPPING_ADDRESS` filter does not catch them either.
- **Native hard negatives are trustworthy.** `PICK_UP` (14 Orders),
  `RETAIL` (15) and `NONE` (32) had zero observed false positives. All three
  are non-delivery, so acting on them can only ever *stop* automation.
- **The native pickup mechanism was abandoned.** Correct `PICK_UP` Orders
  run 2026-04-15 → 2026-06-10; every pickup since is a typed shipping line
  (2026-05-01 → 2026-09-08). This is current practice, not a legacy
  artifact — which is also why a process-only fix was rejected in 6J: it had
  already been tried and drifted.
- **Attribution does not rescue it.** The misclassified Orders come from
  "Draft Orders" and "OfferteApp" — the same sources as genuine deliveries.
- `LOCAL` and `PICKUP_POINT` were **never observed** in production.

### Two layers: translation is not authority

| | Layer 1 — `fulfillment-mode.ts` | Layer 2 — `fulfillment-contract.ts` |
|---|---|---|
| Question | "What does Shopify mean?" | "What may Stones4U act on?" |
| Input | `DeliveryMethodType` | explicit signal + Layer-1 result |
| `LOCAL` | `DELIVERY` (correct translation) | not trusted alone → `UNKNOWN` |
| Changed in 6K | **No** | new |

Layer 1 is unchanged and stays correct as a *translation*. Layer 2 may
legitimately answer `UNKNOWN` for an Order whose Layer-1 translation is a
confident `DELIVERY`. Conflating the two is the exact mistake 6I caught.

### The contract

Carrier: a Shopify Order/DraftOrder **customAttribute** (chosen in 6J over a
metafield — Draft→Order propagation of customAttributes is already proven
here via `requested_delivery_date`, whereas Shopify's draft-order metafield
copy requires matching definitions on both owner types and is undocumented
for API-created drafts).

```
key    stones4u_fulfillment_mode      (exact, case-sensitive)
values DELIVERY | CUSTOMER_PICKUP | PICKUP_POINT | RETAIL | NONE
```

`UNKNOWN` is deliberately **not** writable — it is a read outcome meaning
"we could not establish this", never something a writer states.

**Normalization is explicitly defined, not guessed**: exactly two lossless
transformations are applied on read — trim surrounding whitespace, then
upper-case. So `"DELIVERY "` and `"delivery"` both read as `DELIVERY`.
Nothing else is accepted: `"BEZORGEN"`, `"PICKUP"` and `"Delivery Mode"` are
`INVALID`, never coerced. Writes must emit a canonical value verbatim.

| Read situation | Outcome |
|---|---|
| key absent, or value empty/whitespace | `ABSENT` |
| value matches a canonical mode after normalization | `VALID` |
| value present but unrecognized | `INVALID` (conflict) |
| key present more than once | `DUPLICATE` (conflict) — never resolved by picking one |

### Authority rules (Layer 2)

| Explicit | Native | Resolved | Source | Conflict |
|---|---|---|---|---|
| `DELIVERY` | `DELIVERY` / `UNKNOWN` | `DELIVERY` | EXPLICIT | no |
| `DELIVERY` | any non-delivery | `UNKNOWN` | NONE | **yes** |
| non-delivery mode | anything | that mode | EXPLICIT | no |
| `INVALID` / `DUPLICATE` | anything | `UNKNOWN` | NONE | **yes** |
| absent | `CUSTOMER_PICKUP` / `RETAIL` / `NONE` | that mode | NATIVE | no |
| absent | `DELIVERY` / `PICKUP_POINT` | `UNKNOWN` | NONE | no |
| absent | `UNKNOWN` | `UNKNOWN` | NONE | no |

**The asymmetry is a deliberate safety property.** Resolving to `DELIVERY`
requires strictly stronger evidence than resolving to any non-delivery mode,
because a wrong `DELIVERY` may contact a customer incorrectly (irreversible,
customer-visible) while a wrong non-delivery merely stops automation and
leaves staff to act manually (cheap, recoverable). Hence: an explicit
non-delivery always wins; an explicit `DELIVERY` must not be contradicted;
and a bare native `DELIVERY` is never enough.

An untrustworthy explicit value resolves to `UNKNOWN` rather than falling
back to the native mode — `UNKNOWN` routes to `INSUFFICIENT_CLASSIFICATION`,
which is exactly the "a human should look at this" outcome a corrupted value
deserves.

`native` always arrives as the conservatively aggregated result of
`aggregateFulfillmentMode()`, so a mixed-fulfillment Order enters Layer 2 as
`UNKNOWN` and is never un-mixed afterwards.

### Duplicate keys — a deliberate asymmetry with `requested_delivery_date`

A duplicated `stones4u_fulfillment_mode` fails closed, while a duplicated
`requested_delivery_date` keeps its existing first-match-wins behaviour
(unchanged since 6E). This is not an inconsistency: a duplicated date can
only ever *suppress* a request — safe whichever value wins — whereas a
duplicated mode could *enable* customer contact, so only the latter has to
fail closed.

### Historical Orders

**No backfill.** 6I proved that treating historical `SHIPPING` as `DELIVERY`
would mislabel 29 real pickups. No migration is needed either: the mode is
derived on read, so historical Orders simply resolve to `UNKNOWN` unless a
trusted native negative applies.

### Customer visibility

A customAttribute is operational metadata that Shopify surfaces and themes
*can* render (order status page, templates), the same as the existing
`requested_delivery_date`. Accepted by Fons in 6J. No customer-facing UI or
template change was made, and **Shopify's invoice/factuur communication
remains completely independent and unchanged** — Control Center's
fulfillment/delivery-date communication is additional only, and nothing in
this contract touches invoice behavior.

### Still out of scope after 6K

No writer exists yet — no staff editor, no Order/Draft write endpoint, no
OfferteApp or Source2POS integration, no webshop derivation. The resolved
mode is **not** wired into `evaluateDeliveryRequestDecision()`, and
`READY_FOR_DELIVERY_REQUEST` remains unreachable. `requested_delivery_date`
stays entirely separate: the mode describes *how* goods are provided, the
date *when* the customer wants them, and a mode change never deletes a
historical date.

## Next phase boundary (revised this round — read before planning 6G)

Explicitly **not** built in Phase 6C through 6F: notification outbox, any
provider integration, any transactional mail, the quote-stage
`requested_delivery_date` field (OfferteApp, untouched), any
requested-delivery-date provenance/source tracking, B2B trigger logic, a
positive Order classification rule, production webhook registration of
any topic.

**The notification outbox is explicitly NOT the recommended next step**,
correcting Phase 6F's own original final-report recommendation. The
reason is structural, not sequencing preference: `READY_FOR_DELIVERY_REQUEST`
is *intentionally* unreachable — `hasTrustworthyDeliveryOrderClassification()`
is hard-coded `false` because no reliable signal exists yet for "which
Orders should receive an automatic delivery-date request". An outbox built
now would have no real Order to ever send for; its correctness could not
be meaningfully verified against anything but the always-`false` case.

**The recommended next phase is Delivery Order Classification Discovery /
Design** — establishing a genuinely trustworthy signal (a tagging
convention, a confirmed `sourceName` meaning, a dedicated order-type
field, or something not yet considered) for "this is a regular,
delivery-bound consumer Order" before any notification-sending
infrastructure is built. Only once that exists does building the outbox
become meaningful work with a real business outcome to verify against.
The B2B/on-account classifier is a related, likely-later question — it
needs its own signal and its own non-payment readiness rule, and per the
brief's own boundary is explicitly out of scope until then.

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
6. **New this phase**: the exact provenance enum/tracking design
   (`QUOTE`/`CUSTOMER_PORTAL`/`STAFF_MANUAL`/`B2B`/`UNKNOWN_LEGACY`) once
   the quote-stage entry point actually exists — including whether
   `UNKNOWN_LEGACY` should ever be backfilled onto pre-existing Shopify
   dates with no local record, or left permanently unattributed.
7. **New this phase**: whether the payment-trigger automation (§"Staff
   Order handoff management" above) should fire on Shopify's own paid/
   fulfillment status, on an OfferteApp-signaled invoice event, or both —
   and how the B2B exception's own trigger (if any) should be surfaced to
   staff in the meantime.
8. **New this phase (Phase 6H)**: whether to grant **production** the
   single scope `read_merchant_managed_fulfillment_orders`, enabling the
   read-only production verification described in "Recommended next
   controlled step" above. This is the one scope decision actually on the
   table. `PICK_UP`/`LOCAL`/`PICKUP_POINT`/`RETAIL` could not be
   live-triggered on staging within currently-granted scopes
   (`deliveryProfiles` access was denied), but no additional scope is being
   requested to manufacture them — real production Orders are the better
   and safer evidence, and any further scope request should follow a proven
   access gap rather than precede one.
