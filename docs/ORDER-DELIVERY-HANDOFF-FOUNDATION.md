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

**Not yet live-verified**: the exact `orderUpdate(id: ID!, input:
OrderInput!)` mutation shape needs confirmation against the live Shopify
Admin GraphQL schema for the configured `SHOPIFY_API_VERSION` before this
is exercised with `write_orders` actually granted. Very likely correct
given the direct analogy to the already-proven `draftOrderUpdate`, but not
assumed blindly.

## `write_orders` status

Confirmed absent from the current production scope list
(`read_all_orders`, `read_customers`, `write_draft_orders`,
`read_draft_orders`, `read_orders` — verified live during Phase 6A
discovery). **Not changed in this phase, on either production or
staging** — Phase 6B code compiles and is fully unit-testable without it,
since every Shopify call in the new tests is mocked at the `fetch`
boundary (matches the existing Draft-mirror test convention exactly — no
live Shopify credentials or scope are needed to prove the mirror logic
itself). **No live Order mutation has been performed or proven against a
real Shopify store in this phase** — the `orderUpdate` mutation shape is a
well-grounded candidate (direct analogy to the proven `draftOrderUpdate`),
not a verified fact; staging will need `write_orders` granted before that
proof can happen in a later phase.

**Staging read scope gap found**: a live read-only check during this
phase (`order(id) { customer { id } }` against a real order on
`stones4u-dev.myshopify.com`) returned `ACCESS_DENIED` — staging's Shopify
app currently lacks whatever scope `Order.customer` needs, even though
production already has `read_customers` (and the existing Draft flow
already depends on it for `DraftOrder.customer` matching). This blocks
live end-to-end proof of the *customer-matching* part of
`getOrderForHandoff()` on staging specifically — not Phase 6B itself
(nothing calls this function yet), and not the mirror path (verified
separately, below, with zero errors). Needs a decision/scope grant on
staging before Phase 6C's staging E2E.

The exact same live check confirmed the **mirror's own read query** (`id`,
`cancelledAt`, `displayFulfillmentStatus`, `shippingAddress`,
`customAttributes` — no `customer` field) works with **zero errors**
against a real order on `stones4u-dev.myshopify.com` today.

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

## Next phase boundary (Phase 6C)

Explicitly **not** built here: webhook endpoint, webhook registration,
HMAC verification, notification outbox, any provider integration, any
transactional mail, any staff UI change, any public page change, any
automatic eligibility trigger. All of that is Phase 6C onward, per
`docs/ORDER-DELIVERY-HANDOFF-FOUNDATION.md`'s companion Phase 6A discovery
artifact's phased plan.
