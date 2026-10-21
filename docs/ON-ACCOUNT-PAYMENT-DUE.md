# Op rekening v1 — central payment-due service

Status (2026-10-20): built on branch `feature/on-account-payment-due`. Tested
locally against a real Postgres, with a fake Shopify. **Not on staging or
production.** The service flag `ON_ACCOUNT_SERVICE_ENABLED` defaults to off.
Payment reminders are not built in v1 and stay off.

Sibling branches (both `feature/on-account-v1`):

- Source2POS: `docs/ON-ACCOUNT-V1.md` there.
- OfferteApp: on-account creation, credit check, and "Betaallink nu
  versturen" via this service.

## Principle

An order on account is created **PENDING without payment terms and without
a due date**. The term (snapshot `stones4u.payment_term_days`) only starts
when the goods actually leave: pickup, counter handover, or a confirmed
delivery. At that moment this service:

1. sets FIXED payment terms with `dueAt` = Amsterdam calendar date of
   delivery + N days, 23:59:59 local time (DST-correct);
2. sends the Shopify invoice once (`orderInvoiceSend`, the payment link).

Shopify stays the source of truth for the order. The CRM table only tracks
the progress of this process.

## Shopify metafields (namespace `stones4u`)

| Owner | Key | Type | Set by | Meaning |
|---|---|---|---|---|
| Customer | `credit_allowed` | boolean | CRM (ADMIN, customer page) | Only `true` permits on account |
| Customer | `payment_term_days` | number_integer | CRM | Empty → 30; 1–365 |
| Order | `payment_term_days` | number_integer | POS / OfferteApp after creation | Snapshot, never changes |
| Order | `handed_over_at` | date_time | POS ("direct meegegeven") | Counter handover |
| Order | `invoice_sent_at` | date_time | CRM after a successful send | Marker against a second send |

Plus the order tag `op-rekening` and the hidden attribute
`_stones4u_payment_term_days`. Draft metafields do not carry over, so the
attribute is the atomic fallback. A conflict between the metafield and the
attribute goes to MANUAL_REVIEW. No personal data goes in tags.

**Definitions on dev exist already** (fase 0). For production they must be
created explicitly, with approval: `metafieldDefinitionCreate` for the five
keys above.

## Datamodel (migration `20261020150000_on_account_payment_due`, additive only)

- `OnAccountOrder`: one row per Shopify order (unique
  `shopifyOrderGid`). Columns cover the state, the snapshot term,
  `deliveredAt` + `triggerSource` + `triggerEventId` (written once),
  `dueAt`, `paymentTermsId`, the invoice fields, `attempts` /
  `nextAttemptAt` / `lastError`, and `reviewReason`.
- `OnAccountEvent`: every incoming delivery or invoice event, unique on
  `(source, eventKey)`, with the outcome (APPLIED / IGNORED_* / DUPLICATE).
  This is the idempotency table.

No existing tables are changed.

## State machine (`src/modules/on-account/state-machine.ts`)

```
REGISTERED ─┬─> PENDING_TEMP_TERMS ─> WAITING_FOR_DELIVERY ─> DELIVERED ─> TERMS_SET ─> INVOICE_SENDING ─> INVOICE_SENT ─> PAID
            └────────────────────────> WAITING_FOR_DELIVERY
any non-terminal state ─> PAID | CANCELLED | MANUAL_REVIEW
MANUAL_REVIEW ─> (explicit human decision only)
```

- Every transition is a compare-and-set (`updateMany where state = expected`),
  so two workers can never advance the same row.
- An uncertain send (timeout / 5xx while sending) **never** goes back to
  TERMS_SET automatically. It is resolved only by Shopify's own evidence: the
  `invoice_sent_at` marker or a "sent invoice" order event. Without that
  evidence it goes to MANUAL_REVIEW (`INVOICE_SEND_UNCERTAIN`).
- A verified non-send (Shopify userError) does go back to TERMS_SET, with
  backoff.
- Backoff: 2^n minutes (capped at 6 h). After 10 attempts the order goes to
  MANUAL_REVIEW (`RETRIES_EXHAUSTED`).

## Triggers (v1)

| Trigger | Source | `triggerSource` |
|---|---|---|
| Pickup | OfferteApp audit `customer_pickup_handed_over` (first one counts) | PICKUP_HANDOVER |
| Counter | POS `handed_over_at` (metafield/attribute) | COUNTER_HANDOVER |
| Delivery | CRM button "Afgeleverd bij klant" (employee, timestamp, confirmation, audit) | MANUAL_DELIVERY |
| Manual invoice | OfferteApp "Betaallink nu versturen" → `POST /api/integrations/on-account/send-invoice-now` | MANUAL_INVOICE |

These are **never** a financial trigger: Shopify fulfillment, "Afgeleverd /
Opgehaald", or the Van Eijk pickup.

`deliveredAt` is written once (`where deliveredAt is null`). A later
logistics event is recorded as an ignored event, so after "Betaallink nu
versturen" nothing moves.

On every delivery event the order is checked exactly. It must:

- exist;
- carry the tag;
- be PENDING;
- have outstanding > 0;
- not be cancelled;
- have `deliveredAt` empty.

A partial delivery goes to MANUAL_REVIEW.

## Shopify steps (worker, `reconcileOnAccountOrder`)

1. **Cleanup:** temporary FULFILLMENT terms are still on the order, so read,
   delete, and verify they are gone. Any other term type →
   `UNEXPECTED_PAYMENT_TERMS`.
2. **Terms:** read first. An exact FIXED match is a NO-OP. Otherwise create,
   or update our own term. A different, unknown due date →
   `DUE_DATE_CONFLICT`. Verify afterwards.
3. **Invoice:**
   - adopt the marker if it exists;
   - claim TERMS_SET → INVOICE_SENDING atomically;
   - send once, with no automatic HTTP retry;
   - write the `invoice_sent_at` marker.
4. **Settlement:** orders/paid → PAID; cancelled → CANCELLED.

The webhooks `orders/create` / `orders/paid` only record (fast, no Shopify
call). The Shopify work is done by the worker, `POST /api/internal/on-account/run`
(bearer `ON_ACCOUNT_WORKER_TOKEN`), which must be called every few minutes by
a scheduler.

## Permissions

| Action | Who |
|---|---|
| View the overview | logged-in user |
| "Afgeleverd bij klant", retry | write access (ADMIN/AGENT) |
| Review decisions | ADMIN, note required |
| Change a customer's credit/term | ADMIN, read back from Shopify, audited before and after |
| Send-invoice-now API | bearer `ON_ACCOUNT_SERVICE_TOKEN` (OfferteApp), `confirmed: true`, a `requestId` per request |

All endpoints return 503 while the service flag is off.

## Environment variables (names only)

- CRM: `ON_ACCOUNT_SERVICE_ENABLED`, `ON_ACCOUNT_WORKER_TOKEN`,
  `ON_ACCOUNT_SERVICE_TOKEN`. Both tokens are at least 32 characters; the
  service fails closed.
- OfferteApp: `CONTROL_CENTER_BASE_URL`, `CONTROL_CENTER_ON_ACCOUNT_TOKEN`.

## Scope migration plan (nothing has been changed yet)

| App | Environment | Has (last verified) | Needs to be added | Why |
|---|---|---|---|---|
| CRM "Stones4U Control Center Staging" | stones4u-dev | read_orders, read_draft_orders (+ read_customers / write_orders per Phase 6B.1 — re-verify) | `read_payment_terms`, `write_payment_terms`, `write_customers` (+ `write_orders` if missing) | terms create/update/delete; customer metafields; order metafield + `orderInvoiceSend` |
| CRM "CRM" | production | read_orders, read_all_orders, read_draft_orders, write_orders, write_draft_orders, read_customers | `read_payment_terms`, `write_payment_terms`, `write_customers` | same |
| OfferteApp | staging + prod | already uses FULFILLMENT terms + customer reads | none expected — verify `write_payment_terms` (delete) and `read_customers` | — |
| Source2POS | dev + prod | already uses payment terms + customer search | none expected — verify `write_payment_terms` (delete) | — |

Procedure per app, staging first:

1. Release a new app version with exactly these scopes, via the Dev
   Dashboard, under Scopes.
2. Get the admin's approval on the shop.
3. Verify with `currentAppInstallation { accessScopes { handle } }`:
   requested = granted.
4. Only then deploy.

Production follows only after the staging E2E and explicit approval.
Nothing is added silently.

## Existing open orders (requirement 18)

They are never changed automatically.
`scripts/on-account-open-orders-report.ts` produces a read-only overview:

- tag, financial status, payment term type, `dueAt`, overdue,
  outstanding;
- whether a snapshot is present, and the customer's credit setting;
- an informational assessment.

It contains no personal data. Running it against production requires
explicit approval.

Known deviating orders to check in it:

- OfferteApp #1537, #1555, #1381 (FULFILLMENT, pending) and #1357 (overdue);
- POS #1266, #1283, #1427 (Due on receipt);
- #1421 (created by the CRM app).

The service only registers orders that arrive through the orders/create
webhook after go-live. Adopting old orders is a separate, approved step.

## Open risks / not in v1

- No reminders (`paymentReminderSend` sends even when not due — do not
  enable without a schedule decision).
- Company / B2B credit: later. v1 only reads Customer metafields.
- A draft reused after a failed POS attempt keeps its old marking. A
  conflicting term then goes to MANUAL_REVIEW (no guessing).
- `orderInvoiceSend` has no idempotency key in Shopify. Hence the claim, the
  marker, and the "never resend blindly" rule.

## Scheduler

`src/instrumentation.ts` starts an in-process timer on the CRM's always-on
machines. No extra machine and no extra cost. Every
`ON_ACCOUNT_SCHEDULER_INTERVAL_MS` (default 5 min, minimum 1 min) it POSTs
to the machine's own `/api/internal/on-account/run`, with the worker token.

The run itself (`src/modules/on-account/scheduler.ts`):

- **Lock:** `pg_try_advisory_xact_lock`. Two machines, two ticks, or a
  manual call never overlap; the losing run gets `SKIPPED_LOCKED`.
- **Deadline:** default 4 min. No new order is started after it.
- **Logging:** one JSON log line per run (`on_account_scheduler_run`).
- **Failures:** a failed run writes the audit event
  `on_account.scheduler_failed`. Per-order failures appear as
  `lastError` / MANUAL_REVIEW on /op-rekening.

It is the same idempotent `runOnAccountWorker`, so there is no second
logic.

The timer is off unless `ON_ACCOUNT_SCHEDULER_ENABLED=true`. The route also
refuses while `ON_ACCOUNT_SERVICE_ENABLED` is not `true`.

Alternatives considered:

| Option | Interval | Cost |
|---|---|---|
| Fly scheduled machine | `hourly` at best (too coarse) | ~€0 |
| Extra Fly process group with cron | any interval | ~$2–3/month always-on |
| External cron (GitHub Actions) | best effort, delays | free, extra secret outside Fly |

## Phase I — the definitive invoice and ONE invoice mail

Decision (2026-10-21): **the Shopify order number is the invoice number**
(Shopify order #1842 is invoice 1842). There is no CRM number series, and
nothing waits for Exact Online.

### Flow

The flow replaces Shopify's `orderInvoiceSend` in the automatic path:

```
DELIVERY -> dueAt -> FIXED payment terms (TERMS_SET)
  -> INVOICE_GENERATING   one worker:
       fresh read of the exact order GID
       -> snapshot -> PDF -> stored
  -> INVOICE_READY        the invoice exists, immutable
  -> INVOICE_SENDING      one worker:
       re-read the order, read Shopify's payment URL,
       mail the stored PDF once
  -> INVOICE_SENT
```

### Financial source

The Shopify Order is the only financial source (`src/integrations/shopify/invoice-read.ts`). All amounts are whole cents:
- line `originalTotal`, minus the discount allocations;
- shipping lines;
- the VAT line per rate;
- totals and the outstanding amount.

The snapshot (`invoice/snapshot.ts`) refuses to exist when:
- the lines plus shipping do not add up exactly to the Shopify total and VAT;
- the order was edited or refunded;
- the FIXED due date is not ours;
- there is no invoice address (billing address, then the customer's default address, then the shipping address);
- the Stones4U details are incomplete. Name, address, KvK, VAT number and IBAN are required, and come from OfferteApp Settings.

The unit price excl. VAT (art. 35a Wet OB) is derived for display only.

### PDF

- The PDF is rendered by `invoice/render.ts` (pdfkit, A4). It is byte-for-byte reproducible from the same snapshot.
- It is stored in the existing private R2 bucket under the content-addressed key `invoices/<year>/<number>/<sha256>.pdf`.
- It is recorded in `OnAccountInvoice`, one row per order, unique on the order, GID, number and sendKey, with `onDelete: Restrict`.
- The PDF is never rebuilt. A download (`GET /api/on-account/:id/invoice`) and a mail both verify the checksum first.

### Mail

- The mail goes through OfferteApp, Stones4U's existing SMTP: `POST /api/integrations/control-center/invoice-mail`, with the existing service token.
- **Subject:** "Factuur Stones4U <nr>".
- **Attachment:** `Factuur_<nr>.pdf`.
- **Body:** the invoice facts and a **FACTUUR BETALEN** button.
- The button uses Shopify's own `paymentCollectionDetails.additionalPaymentCollectionUrl`:
  - it is read right before sending;
  - it is accepted only if it is an https `/order_payment/<this order id>` link on an allowed host (`SHOPIFY_SHOP_DOMAIN` plus `ON_ACCOUNT_PAYMENT_LINK_HOSTS`);
  - it is never built by us, and never logged.

### Exactly one mail

- The invoice has a `sendKey`. OfferteApp records an attempt before it talks to SMTP and mails at most once per key.
- **SENT:** INVOICE_SENT.
- **NOT_SENT** (connect, login or recipient refused): back to INVOICE_READY with backoff.
- **No answer from OfferteApp:** the CRM asks `GET /invoice-mail/<sendKey>`; it never resends blindly.
- **UNCERTAIN** (SMTP hand-over broke), or an attempt without an outcome: MANUAL_REVIEW `INVOICE_SEND_UNCERTAIN`.
- **A human "not sent":** a new sendKey for the **same** invoice.

### Paid or cancelled before the mail

- **Paid:** the invoice is still made (bookkeeping), but no payment mail is sent (`mailSuppressedReason PAID_BEFORE_SEND`). The state becomes PAID.
- **Cancelled after the invoice:** no mail (`CANCELLED_BEFORE_SEND`).

### Staging-only fault switches

These are used by the Phase H/I E2E:
- `invoice_pdf_render_fails`
- `payment_link_unavailable`
- `invoice_mail_timeout_before_send`
- `invoice_mail_uncertain`
- `crash_after_invoice_send`

They are inert unless both shop variables are exactly stones4u-dev.

### Before production
- Fill in `company_iban` in OfferteApp production Settings; it is empty today.
- Verify the host of the production payment URL. A custom domain must be added to `ON_ACCOUNT_PAYMENT_LINK_HOSTS`.
