# Phase 3B Implementation Report — Telephony & Quotes Integration

Built 2026-09-02/03, following `docs/platform-discovery/27-PHASE-3-DISCOVERY.md`,
`28-PHASE-3-ARCHITECTURE.md`, `29-PHASE-3-BUILD-SPEC.md`, and
`docs/architecture/ADR-007`/`ADR-008`. Phase 3a remains live in production
and unchanged. **Four repositories were touched**: `D:\Shopify\CRM`,
`D:\Shopify\TelefoonSysteem`, `D:\Shopify\OfferteApp`,
`D:\Shopify\s4u-quote-app` — each with an explicit, separate instruction
naming that repository, per `CLAUDE.md`'s cross-repo rule. **Nothing has
been committed, pushed, or deployed anywhere** (see §Git status). Gmail/3c
was not touched.

## 1. Discovery re-verification (Fase 1)

Re-verified against current code (not assumed from the discovery docs),
via three parallel read-only investigations:

- **TelefoonSysteem** (`f652ead`, unchanged HEAD): `Call` model confirmed
  exactly as documented — no `direction` field, no recording reference.
  `requireAuth` (human JWT) and `requireInternalSecret` (ami-worker-only,
  `x-internal-secret`) confirmed as the only two existing auth mechanisms;
  neither usable for CRM. Express + pnpm/Turborepo monorepo, `apps/api`
  mounts routers in `src/index.ts`/`src/routes/index.ts`. No rate-limiting
  library, no test framework anywhere in `apps/api`. No staging Fly app.
- **OfferteApp** (`88dd2c8`, unchanged HEAD): `Quote` model fields
  confirmed. One correction to the discovery doc: an inbound service-token
  check **does** already exist (`POST /api/warehouse/callback`, an
  `x-integration-key` header compared with plain `!=`, not constant-time) —
  the discovery doc's "no service-auth mechanism exists anywhere" was too
  strong; the *pattern* existed, just not for a read API, and not built
  constant-time. The Shopify-OAuth-callback's `hmac.compare_digest` idiom
  was used instead, as the better reference. Blueprint-per-feature
  structure confirmed; pytest suite already exists (`tests/`, `conftest.py`
  with an `app`/`client` fixture pair). No staging Fly app.
- **s4u-quote-app** (`b9f23f1`, unchanged HEAD): `Quote` model confirmed —
  critically, **no Shopify Customer GID field at all** (only
  OfferteApp has one). `health.tsx`/`health.db.tsx` confirmed as an
  existing precedent for a Shopify-auth-free resource route. An in-memory
  rate limiter already exists (`app/lib/rate-limiter.server.ts`) and was
  reused rather than rebuilt. No shared code/DB with OfferteApp (re-grepped,
  zero hits). No staging Fly/Shopify-app environment.
- **Deployment topology** (`fly apps list`): confirmed only
  `stones4u-control-center-staging` exists — TelefoonSysteem, OfferteApp,
  and s4u-quote-app all have exactly one (production) Fly app each. This
  directly determined the Fase 13 outcome (see §14).

## 2. Service-auth design (Fase 2)

**One consistent pattern across all three sibling apps**: a **Bearer
service token** in the `Authorization` header, one distinct secret per
(CRM ↔ sibling) pair (never shared between apps, never shared with any
other credential already in that app), compared in constant time, never
accepted via query string.

**Why Bearer-token over HMAC-per-request**: all three integrations are
low-volume, read-only, server-to-server calls over TLS (Fly apps are
HTTPS-only) between systems the same operator controls — HMAC request
signing would add meaningfully more implementation surface (three
different stacks: Express, Flask, Remix) without a proportional security
gain here, since TLS already protects the token in transit and constant-time
comparison already protects against timing attacks on the comparison
itself. A Bearer token is also the pattern each app already had a partial
precedent for (TelefoonSysteem's `x-internal-secret`, OfferteApp's
`x-integration-key`), so it stays consistent with what already exists
rather than introducing a fourth pattern.

Per-app implementation (each mirrors that app's own strongest existing
constant-time-comparison idiom):

| App | Middleware/check | Comparison |
|---|---|---|
| TelefoonSysteem | `requireCrmServiceToken` (`apps/api/src/middleware/auth.ts`) | `crypto.timingSafeEqual` |
| OfferteApp | `_require_service_token()` (`app/blueprints/integrations/api.py`) | `hmac.compare_digest` |
| s4u-quote-app | `requireServiceToken()` (per-route) | `crypto.timingSafeEqual` |

Rate limiting: TelefoonSysteem and OfferteApp got a new minimal in-process
sliding-window limiter (60 req/min) — neither had any rate-limiting
library; s4u-quote-app reused its existing `checkRateLimit()`. All
per-process only (no shared store) — acceptable for a single known caller.

## 3. New endpoints per app (Fase 3/4)

| App | Route | Auth | Notes |
|---|---|---|---|
| TelefoonSysteem | `GET /integrations/control-center/calls?phone=` | Bearer | Mounted outside `/api` and `/internal`, its own namespace |
| TelefoonSysteem | `GET /integrations/control-center/calls/:externalId` | Bearer | |
| OfferteApp | `GET /api/integrations/control-center/quotes?shopifyCustomerId=&email=&phone=&number=` | Bearer | OR-combined filters |
| OfferteApp | `GET /api/integrations/control-center/quotes/<uuid>` | Bearer | |
| s4u-quote-app | `GET /api/integrations/control-center/quotes?email=&phone=&number=` | Bearer | No `shopifyCustomerId` param — no such field exists |
| s4u-quote-app | `GET /api/integrations/control-center/quotes/:id` | Bearer | |

All six are read-only (GET only), capped at 25 results, minimal payloads
(no address/note/internal-comment fields), and return generic 401/404/500
bodies that never leak internals.

## 4. Telephony adapter

`src/integrations/telephony/adapter.ts` — `TelefoonSysteemAdapter` replaces
`DisabledTelephonyAdapter` whenever `TELEFOONSYSTEEM_API_BASE_URL` +
`TELEFOONSYSTEEM_SERVICE_TOKEN` are both set. Queries by phone number
(dedup by candidate number, dedup by call id), 8s timeout, degrades to `[]`
on any failure (timeout/non-2xx/network error) — never throws. **Direction
is never guessed**: TelefoonSysteem always reports `"UNKNOWN"`, and the
adapter never populates `TelephonyActivityItem.direction` from it — that
field stays reserved for a future real signal. Disposition (RINGING/
ANSWERED/ENDED/MISSED/ABANDONED) is translated to a Dutch label and shown
in the summary instead.

## 5. Quotes adapter

`src/integrations/quotes/adapter.ts` — `FederatedQuotesAdapter` federates
both sibling apps. Matching preference order (ADR-007 tiers), each tried
only if the previous tier found nothing:

1. Shopify Customer GID → OfferteApp only (legacy ID extracted from the GID)
2. an existing confirmed `ExternalContactMatch` (via `getMatchesForCustomer`)
3. exact normalized email → both apps
4. exact normalized phone → both apps
5. unresolved → `[]`

**Dedup**: two quotes from different sources referencing the same Shopify
draft-order GID are treated as one commercial event; OfferteApp's record
wins the collision (documented, arbitrary tie-break — the older, more
established internal system). Quotes without a shared draft order are
never deduped against each other.

`searchQuotesByNumber()` — a separate function, used only by Command
Palette — queries both apps' `number` filter directly (no tiering, since
there's no known customer yet) and resolves each hit to an *existing*
`CustomerProfile` via GID or normalized email; a quote that resolves to no
CustomerProfile is dropped (nowhere to navigate to — same rule
`order-search.ts` already applies to orders).

## 6. Customer matching (Fase 6)

No changes to `ExternalContactMatch`/`matching.service.ts` — reused exactly
as ADR-007 specifies. No fuzzy name matching anywhere. No silent ambiguous
resolution anywhere (the quotes adapter's tiering explicitly prefers
"nothing found" over a weaker, possibly-wrong signal).

## 7. Customer 360 UX (Fase 7)

**Zero new top-level tabs** (still 7, as in Phase 3a). Overview gained one
new compact block, **"Recente gesprekken"** (`RecentCallsBlock.tsx`, latest
5 calls, empty-state-safe) — the block Phase 3a's build spec explicitly
deferred to 3b (`29-PHASE-3-BUILD-SPEC.md` §5: *"de 'Recente gesprekken'/
'Recente e-mails'-blokken horen bij 3b/3c"*). Commercieel gained one new
sub-section, **"Offertes"** (`QuotesTable.tsx`), alongside the existing
Bestellingen/Conceptbestellingen. `AdapterStatusBanner` now also reports
quotes-adapter availability.

## 8. Unified Timeline (Fase 8)

`getCustomerTimeline()` gained a `quoteMatchRefs` context parameter and a
`quoteTimelineItems` projection. Every quote produces exactly one
`QUOTE_CREATED` item (never a synthesized `QUOTE_UPDATED` — neither source
exposes an update history this could attribute meaningfully). Calls use the
existing generic `"CALL"` kind (not `CALL_INBOUND`/`CALL_OUTBOUND`) — a
direct application of the build spec's own explicit fallback ("of generiek
CALL indien richting niet betrouwbaar is") given the confirmed direction
limitation. Stable synthetic IDs: `telefoon-{id}`,
`{offerteapp|s4u_quote_app}-{externalId}`. Nothing is ever persisted as a
local `Activity` row (ADR-008, category B).

## 9. Command Palette (Fase 9)

**New**: quote-number search (`quotes` group, `FileText` icon) — typing a
quote number resolves to its customer and navigates to
`/customers/{id}?tab=orders`.

**Fixed, not built new**: phone-number → customer search. This was assumed
already covered by Shopify's default customer-search query (which does
match phone), but **live testing during Fase 12 disproved that assumption**
for the raw Dutch "06…" form specifically — Shopify's search matches
`"6…"`/`"31…"`/`"+31…"` but returns zero results for `"06…"`. Fixed with a
one-line, targeted change in `searchCustomers()`
(`src/modules/crm/customer-profile.service.ts`): a phone-shaped search term
is normalized via the existing `normalizeDutchPhone()` before being sent to
Shopify. Verified working live, before and after, against real Shopify
data (see §12).

No new live-query-per-keystroke concern: this reuses the exact same
200ms-debounced, 2-char-minimum `/api/search` endpoint Phase 1/2/3a already
built — no new client-side polling behavior was added.

## 10. Security / threat model (Fase 10)

**New inter-service trust boundaries**: CRM (server-to-server, outbound)
→ TelefoonSysteem `/integrations/control-center/*`, CRM → OfferteApp
`/api/integrations/control-center/*`, CRM → s4u-quote-app
`/api/integrations/control-center/*`.

**Threat model**:
- *Credential theft (stolen service token)*: an attacker with a stolen
  token can read calls/quotes for arbitrary phone numbers/emails/IDs from
  that one sibling — bounded to read-only, non-mutating access, and
  bounded to that one app (tokens are not shared across apps or reused for
  anything else). Mitigation: token only ever in env vars / Fly secrets,
  never logged, never in a frontend bundle, never in a query string
  (harder to leak via access logs/browser history/proxy logs than a header).
- *Timing attack on the token comparison*: mitigated by constant-time
  compare on all three sides (`crypto.timingSafeEqual` / `hmac.compare_digest`).
- *IDOR*: the sibling endpoints have no per-customer access boundary
  (any valid CRM token can read any call/quote) — this matches the
  existing, already-accepted CRM permission model (any logged-in CRM user,
  including VIEWER, can already read any customer's orders/notes/etc.;
  there is no per-customer ACL anywhere in this app). Not a new gap.
- *PII exposure*: every response is minimal by construction — no
  address/note fields, no caller name, no line-item detail. Verified by a
  dedicated test in both OfferteApp and s4u-quote-app (`test_response_never
  _includes_address_or_internal_note_fields` / the "never returns
  address/note fields" test).
- *Sibling user-session impersonation*: never attempted anywhere — every
  adapter call uses its own dedicated service token, never a human
  JWT/Flask-session/Shopify-session from any sibling app.
- *Denial of service against a sibling*: bounded by the new per-process
  rate limiters (60/min) plus CRM's own 8s timeout + fail-isolation (a
  slow/unavailable sibling degrades that one section, never the whole
  Customer 360 page).
- *ExternalContactMatch write access*: unchanged from Phase 3a —
  `matching.service.ts` still throws `ForbiddenError` for `VIEWER` on
  every write path; this was re-verified live in production during the
  Phase 3A production task (VIEWER POST → 403, zero rows created) and no
  code in this phase touched that file.

## 11. Tests per repo

| Repo | New tests | Result |
|---|---|---|
| TelefoonSysteem | 11 (`controlCenter.test.ts`) | 11/11 pass |
| OfferteApp | 14 (`test_integrations_control_center.py`) | 14/14 pass; full suite 390/394 pass, 4 pre-existing unrelated failures (verified via `git stash` — identical failures with this phase's changes fully removed) |
| s4u-quote-app | 12 (quotes route tests) | 12/12 pass; full suite 289+12=301/301 pass |
| CRM | 23 new (telephony-adapter 7, quotes-adapter 9, quotes-search 4, customer-profile +3) | 142/142 pass (one unrelated pre-existing flaky real-DB test observed once, confirmed non-reproducing on re-run and in isolation) |

`npm run typecheck && npm run lint && npm run build` — all green in CRM.
`npm run typecheck` green in s4u-quote-app. TelefoonSysteem's `tsc --noEmit`
shows pre-existing errors in files this phase never touched (stale/mismatched
generated Prisma-client types unrelated to this work) — the one file this
phase added compiles clean on its own.

## 12. Local end-to-end integration test (Fase 12)

All three sibling apps were run **for real, locally**, against **fresh,
dedicated local Postgres containers** (never production credentials,
never production data):

1. TelefoonSysteem `apps/api` — real Postgres, migrated, one seeded `Call`
   row, `ts-node` server on port 4001.
2. OfferteApp — real Postgres, migrated (`flask db upgrade`), one seeded
   `Quote` row, Flask dev server on port 4002.
3. s4u-quote-app — real Postgres, migrated, one seeded `Quote` row, Remix
   Vite dev server on port 4003 (bypassing the Shopify CLI tunnel — a
   dummy `SHOPIFY_API_KEY`/`SECRET` is enough since the new route never
   calls `authenticate.admin`).

Verified directly via `curl` against all three (401 without a token, 200
with the correct token, correct JSON shape) — then CRM's actual adapter
code (`createTelephonyAdapter()`, `createQuotesAdapter()`) was run against
all three live servers via a throwaway script, producing real parsed
results from real HTTP calls (not mocks).

Then CRM's own dev server was started, pointed at the three local sibling
servers, and the existing `viewer@stones4u.local` test account (throwaway
password set via Prisma Studio's GUI, restored byte-for-byte afterward —
`fons@verkoelengroep.nl` untouched) was used to visually confirm, against
the real "Fons Verkoelen" `CustomerProfile` (whose real Shopify
GID/email/phone happened to match the seeded OfferteApp quote):

- **Overview**: the quote appears at the top of "Recente activiteit";
  "Recente gesprekken" correctly shows "Geen recente gesprekken" (the
  seeded call's number legitimately doesn't match Fons's phone — proving
  the empty state, not just the populated state).
- **Commercieel → Offertes**: `OFF-2026-0903-999 · OfferteApp · saved ·
  EUR 250.00` renders correctly with a working external link.
- **Activiteit**: `Offerte OFF-2026-0903-999` appears with the correct
  icon/tint at the top of the timeline.
- **Command Palette**: typing `0903-999` finds the quote and navigates
  correctly; typing `0649899477` (Fons's real phone, raw local format)
  initially returned **zero results** — this is what surfaced the phone-
  search bug fixed in §9, re-verified live afterward to return "Fons
  Verkoelen" correctly.

No console errors, no HTTP 5xx, anywhere in this pass.

All three local servers, both extra local Postgres containers, and the
throwaway CRM viewer-account password were fully torn down/restored
afterward — see §16.

## 13. Environment variables (CRM side, names only)

Added to `.env.example` (all optional — unset keeps the adapter disabled):

```
TELEFOONSYSTEEM_API_BASE_URL
TELEFOONSYSTEEM_SERVICE_TOKEN   (already-documented var names from Phase 1, now actually used)
OFFERTEAPP_API_BASE_URL
OFFERTEAPP_SERVICE_TOKEN
S4U_QUOTE_APP_API_BASE_URL
S4U_QUOTE_APP_SERVICE_TOKEN
```

Sibling-side (names only, added to each app's own `.env.example`):
`CRM_SERVICE_TOKEN` (present in all three — same name, three **different**
secret values, one per app; never the same literal token reused).

## 14. Deployment / staging situation per repo

| Repo | Staging exists? | Action taken |
|---|---|---|
| TelefoonSysteem | **No** — production-only Fly app | Code written and tested locally; **not deployed anywhere** |
| OfferteApp | **No** — production-only Fly app | Code written and tested locally; **not deployed anywhere** |
| s4u-quote-app | **No** — production-only Fly app | Code written and tested locally; **not deployed anywhere** |
| CRM | Yes — `stones4u-control-center-staging` | Code written and tested locally; **not deployed** (gated on the three rows above, per explicit instruction) |

Per the explicit instruction: *"Als TelefoonSysteem/OfferteApp/s4u-quote-app
geen aparte staging deployment hebben: STOP voordat je een sibling-app
productieomgeving wijzigt."* All three lack one — this STOP condition is
in effect. No sibling app's Fly/production environment was touched in any
way. CRM's own staging deploy was also withheld, since the adapters would
have nothing real to reach there (and deploying CRM alone teaches nothing
new — its own adapters already degrade to "disabled" gracefully when the
env vars are unset, exactly like Phase 1/2/3a's other adapters).

## 15. Blockers

**The blocker is deployment topology, not code.** All code across all four
repos is written, tested (unit + real local integration), and verified
working end-to-end. What's missing before any of this can go live:

1. A safe way to deploy the three sibling-app changes without risking their
   only (production) environment — e.g. a staging Fly app per sibling, or
   an explicitly accepted direct-to-production deploy with a rollback plan,
   which is Fons' call, not a default this task takes.
2. Three real service-token secrets to be generated and set via `fly
   secrets set` on each sibling app + the corresponding CRM env vars —
   not generated or shown by this task (never done for any secret in this
   project).

## 16. Git status per repo

**TelefoonSysteem**:
```
 M apps/api/package.json
 M apps/api/src/config/index.ts
 M apps/api/src/index.ts
 M apps/api/src/middleware/auth.ts
 M infra/env/.env.example
 M pnpm-lock.yaml
?? apps/api/src/lib/rateLimit.ts
?? apps/api/src/routes/integrations/
?? apps/api/vitest.config.ts
```

**OfferteApp**:
```
 M .env.example
 M app/__init__.py
 M app/config.py
?? app/blueprints/integrations/
?? tests/test_integrations_control_center.py
```

**s4u-quote-app**:
```
 M .env.example
?? app/routes/__tests__/api.integrations.control-center.quotes.test.ts
?? app/routes/api.integrations.control-center.quotes.$id.tsx
?? app/routes/api.integrations.control-center.quotes.tsx
```

**CRM**:
```
 M .env.example
 M src/app/(app)/customers/[id]/AdapterStatusBanner.tsx
 M src/app/(app)/customers/[id]/page.tsx
 M src/app/api/search/route.ts
 M src/components/layout/CommandPalette.tsx
 M src/integrations/quotes/adapter.ts
 M src/integrations/telephony/adapter.ts
 M src/modules/activity/timeline.ts
 M src/modules/crm/customer-profile.service.ts
 M tests/customer-profile.test.ts
?? docs/build/PHASE-3B-IMPLEMENTATION-REPORT.md
?? src/app/(app)/customers/[id]/QuotesTable.tsx
?? src/app/(app)/customers/[id]/RecentCallsBlock.tsx
?? tests/quotes-adapter.test.ts
?? tests/quotes-search.test.ts
?? tests/telephony-adapter.test.ts
```

Nothing committed, nothing pushed, nothing deployed, in any of the four
repositories. No sibling-repository change beyond the three explicitly
named and instructed. `.venv`/`node_modules` created for local testing are
gitignored, not tracked, not shown above.

## 17. Explicitly not built

- Gmail/Phase 3c — untouched, as instructed.
- Any UI for `ExternalContactMatch` resolution (unchanged from Phase 3a —
  still no UI exists; still not needed until an ambiguous match actually
  occurs in practice).
- A `direction` field on TelefoonSysteem's `Call` model — still out of
  this repo's control; direction stays `"UNKNOWN"` everywhere.
- Recordings/call audio — TelefoonSysteem still has no recording reference
  at all; nothing to build against.
- Any deploy, anywhere, to any environment (local integration test
  excepted — fully torn down afterward).
- A general-purpose public API on any sibling app — every new route is
  narrowly scoped to exactly what Customer 360 needs, behind its own
  dedicated credential.

## 18. Recommended next action

Bring the two items in §15 to Fons as an explicit decision point:
(a) how the three sibling apps should get a safe deployment path (staging
Fly app per app, vs. an accepted direct-to-production rollout with a
rollback plan), and (b) authorization to generate the three service-token
secrets. Once both are resolved, staging deployment for all four repos
becomes a normal, gated next step — no further design or implementation
work is blocking it.

## PHASE 3B READY FOR STAGING: NO

**Reason (external, not a code/design gap)**: none of TelefoonSysteem,
OfferteApp, or s4u-quote-app has a staging environment — each has exactly
one (production) Fly app. Per the explicit instruction, deploying this
phase's sibling-side changes there would mean deploying straight to
production, which was not authorized and was not done. CRM's own code is
fully built, tested, and verified end-to-end against real local instances
of all three sibling apps (§12) — it is staging-ready the moment a safe
deployment path exists for the three sibling repos (§15/§18).
