# Quote Delivery Date — Manual Staff Activation (Phase 5A)

Phase 5A gives staff a deliberate, in-portal way to create a
`DeliveryDateHandoff` for a Shopify Draft Order and copy its public link.
Nothing in this phase creates a handoff automatically, changes OfferteApp,
or sends email. It builds directly on the dormant production capability
shipped in Phase 4B (`stones4u-control-center` v20) — that capability had
zero automatic creation paths, so this phase's staff UI is the first thing
that can ever put a row in the `DeliveryDateHandoff` table in production.

## 1. Staff flow

1. Staff opens **Leverdatum-links** (`/delivery-handoffs`, under "Sales" in
   the sidebar).
2. Staff searches by Draft Order number/name (min. 2 characters, 300ms
   debounce). The search calls `searchDraftOrdersForHandoff()`
   (`src/integrations/shopify/order-search.ts`) — a read-only Shopify
   GraphQL query, deliberately separate from the existing command-palette
   search (`searchShopifyOrders`) because that one silently drops drafts
   with no Shopify customer and doesn't return `status`; a handoff must
   stay creatable for a customer-less draft.
3. Results show the draft's name, status, and customer name (if any) — no
   further Shopify detail is fetched or shown.
4. Staff clicks **"Leverdatumlink aanmaken"**. The portal:
   - resolves the draft's Shopify customer GID (if present) to an
     *existing* `CustomerProfile`, never creating one (§4 below);
   - creates the `DeliveryDateHandoff` row, or returns the existing one if
     the draft already has one (§8 below);
   - shows the public URL once, in a dialog, with a copy button.
5. Staff copies the link and shares it with the customer through whatever
   channel is appropriate (phone, email client, etc.) — **the portal never
   sends it itself**.
6. A management table below lists every handoff (all customers), with
   draft reference, linked customer, requested delivery date, status, and
   last-updated time, plus a **"Vernieuw link"** action per row.

No email sending, no OfferteApp call, and no automatic creation exist
anywhere in this phase — creation only ever happens from an explicit staff
click.

## 2. Permissions

- Route group `(app)/layout.tsx` already requires a logged-in session for
  every page under it, including `/delivery-handoffs` — unauthenticated
  requests redirect to `/login` (verified: `307` on staging).
- `GET /api/delivery-handoffs` and `GET
  /api/delivery-handoffs/draft-order-search` require any logged-in staff
  member (`requireUser()`) — VIEWER included, since browsing existing links
  and searching drafts are read-only.
- `POST /api/delivery-handoffs` (create) and `POST
  /api/delivery-handoffs/[id]/regenerate-token` require
  `requireWriteAccess()` — ADMIN or AGENT only, VIEWER excluded. This is
  the same guard function already used and tested elsewhere in the portal
  (`tests/guards.test.ts`); Phase 5A adds no new authorization logic.
- The staff UI itself hides the search box and the "Vernieuw link" button
  entirely for VIEWER (`canCreate={user?.role !== "VIEWER"}`), on top of
  the server-side guard — a VIEWER hitting the create endpoint directly
  still gets a `403`.
- There is no public/unauthenticated create endpoint. The only
  unauthenticated route in this feature is the pre-existing
  `/delivery/[token]` public flow, unchanged by this phase.

## 3. External identity & customer linking

- `sourceSystem` stays `SHOPIFY`, `externalId` stays the Shopify Draft
  Order GID — unchanged from Phase 2A. No local Quote/Order copy is ever
  created.
- The client sends a Shopify **Customer** GID (taken directly from the
  search result, i.e. from Shopify's own association with the draft), not
  a `CustomerProfile.id`. The server resolves that Customer GID to an
  existing `CustomerProfile` via `resolveCustomerProfileIdForShopifyGid()`
  and links it if found.
- If no match is found — or the draft has no Shopify customer at all — the
  handoff is created with `customerProfileId: null`. **A `CustomerProfile`
  is never fabricated purely to have something to link a handoff to.**
  This is enforced by construction: `resolveCustomerProfileIdForShopifyGid`
  only ever calls `CustomerProfile.findUnique`, never `.create`.
- A raw `customerProfileId` from the client is no longer accepted at all
  (Phase 2A's route did; Phase 5A's route removed it) — a client can only
  ever link a handoff to whichever customer Shopify itself already
  associates with the draft, never an arbitrary one.

## 4. Shopify reads — no mutation during creation

Draft lookup, search, handoff creation, and customer resolution are all
Shopify-**read**-only or pure-database operations:

- `searchDraftOrdersForHandoff()` issues one `draftOrders(...)` GraphQL
  query — no mutation, and it never calls the write-safety guard
  (`assertShopifyWriteAllowed()`), because it performs no write. Proven in
  `tests/delivery-handoff-shopify.test.ts` (exactly 2 fetch calls — OAuth
  token + the query itself — and the query string is asserted not to match
  `/mutation/i`).
- `createDeliveryDateHandoff()` and `resolveCustomerProfileIdForShopifyGid()`
  touch only the local database — proven in `tests/delivery-handoff.test.ts`
  ("no Shopify mutation during creation or customer resolution": the
  existing Shopify-mirror mock is asserted never called by either
  function).
- Verified live on staging (§7): a synthetic Draft Order's
  `customAttributes` were read before and after handoff creation and found
  byte-for-byte identical.

The **only** Shopify mutation anywhere in this feature remains what it was
in Phase 2A: the customer's own `POST` on the public `/delivery/[token]`
flow, which mirrors the requested date onto the draft's
`customAttributes`. Regenerating a token, creating a handoff, and
searching drafts all stay strictly read-only or database-only.

## 5. Token lifecycle

- Creation generates a 256-bit raw token, returns it exactly once in the
  API response, and persists only its HMAC-SHA256 hash
  (`publicTokenHash`). The raw value is never logged and cannot be
  recovered from the database afterward — unchanged from Phase 2A.
- **Lost-link recovery**: if staff loses the link after leaving the
  screen, `POST /api/delivery-handoffs/[id]/regenerate-token` overwrites
  `publicTokenHash` on the **same row** with a freshly generated token.
  This permanently invalidates the old link and leaves every other field
  (`status`, `requestedDeliveryDate`, `shopifyDraftOrderGid`,
  `customerProfileId`, `createdAt`) untouched.
- Regenerating instead of revoke-and-recreate was chosen deliberately: a
  new row would collide with the existing
  `@@unique([sourceSystem, externalId])` constraint and would need an
  awkward revoke-then-recreate two-step. Overwriting the hash in place is
  simpler and needs no schema change.
- Verified live on staging: the token issued at creation stopped resolving
  immediately after regeneration; the new token resolved correctly and
  successfully drove the existing public flow through to a Shopify
  invoice redirect.
- Every regeneration is audited (`delivery_handoff.token_regenerated`),
  same as creation (`delivery_handoff.created`).

## 6. Duplicate strategy

`createDeliveryDateHandoff()` is idempotent per `(sourceSystem,
externalId)`, matching the schema's unique constraint: calling it a second
time for a draft that already has a handoff returns the **existing** row
with `rawToken: null` (no new token is issued — the caller must already
have the original link, or use "Vernieuw link" if it's lost) and
`alreadyExisted: true` in the API response. No second row is ever created
for the same draft. The staff UI surfaces this distinctly — the
confirmation dialog explains that a link already existed and points to
"Vernieuw link" instead of implying a fresh one was made. Verified live on
staging: creating twice for the same Draft Order left exactly one
`DeliveryDateHandoff` row.

## 7. Staging end-to-end test (2026-09-09)

Run against `stones4u-control-center-staging` and
`stones4u-dev.myshopify.com`, using a synthetic Draft Order created for
this test (`#D25`, `gid://shopify/DraftOrder/1540338909529`, no customer,
one custom line item, note marking it as synthetic test data). Verification
imported the real, deployed application code (Prisma client and the exact
token-hashing/creation logic as shipped) running inside the staging
container, plus real HTTP calls to the deployed public routes — not a
reimplementation running elsewhere.

| Step | Result |
|---|---|
| Search finds the synthetic draft | ✅ `status: OPEN`, `customerGid: null` |
| Draft `customAttributes` before creation | `[]` |
| No pre-existing handoff for the draft | ✅ confirmed |
| Handoff created | ✅ `status: PENDING`, `customerProfileId: null` (draft had no Shopify customer) |
| Draft `customAttributes` after creation | `[]` — **identical to before** |
| Second create for the same draft | ✅ returns the same row (`ROW_COUNT_FOR_GID: 1`) |
| Old token resolves before regeneration | ✅ true |
| Token regenerated | ✅ |
| Old token resolves after regeneration | ✅ false (correctly invalidated) |
| New token resolves | ✅ true |
| Existing public `GET /delivery/[token]` | ✅ `200` |
| Existing public `POST /api/delivery/[token]` | ✅ `200`, returned a `stones4u-dev.myshopify.com` invoice redirect URL |
| Final row state | `status: MIRRORED`, `requestedDeliveryDate: 2026-10-15`, `lastMirrorAt` populated |

This proves the hard requirement from §1/§9 of the Phase 5A brief — Shopify
is never mutated by search, creation, customer resolution, or token
regeneration — while confirming the pre-existing public delivery-date flow
still works unchanged end to end.

**Cleanup**: the synthetic `DeliveryDateHandoff` row was deleted from the
staging database, and the synthetic Draft Order `#D25` was deleted from
`stones4u-dev.myshopify.com` (`draftOrderDelete`, no errors) — no leftover
test data remains in either system.

## 8. Production rollout plan (not executed this phase)

Production (`stones4u-control-center`) already runs the Phase 4B build
with the dormant `DeliveryDateHandoff` capability and zero rows. Phase 5A
only adds a staff-facing creation path; it changes nothing about the
public flow's Shopify write-safety guard or scopes, so the rollout is a
plain code deploy, not a data or config migration:

1. Confirm on staging one more time that `npm run typecheck && npm run
   lint && npm run test && npm run build` are green on the exact commit
   being promoted (already true as of this report).
2. Deploy to `stones4u-control-center` (`fly deploy --config fly.toml
   --app stones4u-control-center`) — no schema change, so this is a
   plain rolling deploy, not a migration event.
3. Confirm after deploy: `/delivery-handoffs` is reachable and requires
   login; `DeliveryDateHandoff` count is still `0` (nothing auto-created
   by the deploy itself); an ADMIN/AGENT account can reach the create UI;
   a VIEWER account cannot see the create button and gets `403` if it
   calls the create endpoint directly.
4. **First real handoff must be created deliberately by staff**, against a
   real production Draft Order, only after the above is confirmed — this
   is the actual "activation" moment, not the deploy itself.
5. No OfferteApp change accompanies this rollout, and none is needed.
6. No automatic email is sent by this feature at any point; staff share
   the link manually, as designed.

This plan requires a separate, explicit GO before execution — it is not
carried out as part of Phase 5A.
