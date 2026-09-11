import "server-only";
import type { OrderForHandoffResult } from "@/integrations/shopify/order-for-handoff";
import type { FulfillmentMode } from "@/integrations/shopify/fulfillment-mode";
import type { PaymentPolicy } from "@/integrations/shopify/customer-classification";
import { evaluateDeliveryDateEligibility } from "./eligibility";

// Phase 6F — the single, typed business decision: "should Stones4U ask
// this customer for a delivery date?". Deliberately separate from the
// technical events that trigger it (build instruction §4): an
// ORDERS_CREATE or ORDERS_PAID webhook never means "create a handoff" or
// "send an email" — it only means "the Order's state may have changed,
// re-evaluate it". Every webhook handler calls this one function rather
// than scattering loose booleans through route code.
//
// This composes (never duplicates) the Phase 6C eligibility engine: the
// three hard negatives it already decides — cancelled, a delivery date is
// already known, no shipping address — keep exactly their existing
// meaning and priority here. What 6F adds on top is only what the older
// engine had no concept of: the payment precondition, the customer
// policy, and an explicit ambiguity outcome.

/** Which technical event caused this evaluation. Recorded for
 * observability only — the decision itself is derived from the canonical
 * Order re-read, never from which webhook happened to wake us up. */
export type DeliveryRequestTrigger = "ORDER_CREATED" | "ORDER_PAID" | "STAFF_REVIEW";

/**
 * Which delivery-request policy applies to this Order's customer.
 *
 * `UNKNOWN` is not a placeholder — it is the deliberate, safe answer for
 * "we have not reliably classified this Order's customer/business type
 * yet", and it is structurally distinct from `REGULAR_CONSUMER` on purpose
 * (final review, this round): an unclassified Order must never be silently
 * treated as a regular consumer, because a future B2B/on-account Order can
 * legitimately be unpaid and must not be mislabeled `WAITING_FOR_PAYMENT`
 * merely because no classification was available. `UNKNOWN != REGULAR_CONSUMER`
 * is the entire point of this type existing.
 *
 * Stones4U's real, implemented policy today is `UNKNOWN` for every Order —
 * no reliable per-Order classification source exists yet (see
 * hasTrustworthyDeliveryOrderClassification()'s own doc comment for why).
 * `REGULAR_CONSUMER` (payment required) and `B2B_ON_ACCOUNT` (payment
 * explicitly not the trigger — goods on account, concept orders, later
 * bundled invoicing) are real, known future cases with no classifier yet;
 * `MANUAL_ONLY` covers "never ask automatically, staff decides". None of
 * the three non-`UNKNOWN` values is ever inferred from payment state,
 * shipping-address presence, customer presence, `sourceName`, or `tags` —
 * only a genuinely trustworthy future classifier may set one, and until it
 * exists, passing anything other than `UNKNOWN` is a caller bug.
 */
export type DeliveryCustomerPolicy = "UNKNOWN" | "REGULAR_CONSUMER" | "B2B_ON_ACCOUNT" | "MANUAL_ONLY";

export type DeliveryRequestDecisionReason =
  | "ORDER_CANCELLED"
  | "ALREADY_HAS_REQUESTED_DELIVERY_DATE"
  | "NO_SHIPPING_ADDRESS"
  /** Phase 6W — the resolved Stones4U fulfillment mode is a definite
   * mode for which no fulfillment date applies (RETAIL / NONE / PICKUP_POINT
   * — since 6AH, NOT CUSTOMER_PICKUP). Distinct
   * from INSUFFICIENT_CLASSIFICATION on purpose: this is "we know, and the
   * answer is no", not "we don't know". */
  | "NOT_A_DELIVERY_ORDER"
  | "MANUAL_ONLY_POLICY"
  | "WAITING_FOR_PAYMENT"
  | "INSUFFICIENT_CLASSIFICATION"
  | "READY_FOR_DELIVERY_REQUEST";

export type DeliveryRequestDecision = {
  shouldRequest: boolean;
  reason: DeliveryRequestDecisionReason;
  trigger: DeliveryRequestTrigger;
};

/** Only the regular consumer flow gates on payment. A future B2B/on-account
 * Order must never be rejected merely for being unpaid — payment, order,
 * invoice and delivery stay four independent concepts. `UNKNOWN` and
 * `MANUAL_ONLY` never reach this lookup at all (both are rejected earlier,
 * before payment is ever consulted — see the priority order below), so
 * their entries here are unreachable defensive completeness only. */
const POLICY_REQUIRES_PAYMENT: Record<DeliveryCustomerPolicy, boolean> = {
  UNKNOWN: false,
  REGULAR_CONSUMER: true,
  B2B_ON_ACCOUNT: false,
  MANUAL_ONLY: false,
};

/**
 * Whether this Order is *positively* known to be one Stones4U should
 * proactively ask a fulfillment date for — a delivery to arrange, or a pickup
 * to prepare.
 *
 * **Phase 6W — this is where the long-standing hard `return false` finally
 * went away, and it is worth being precise about what replaced it.**
 *
 * From Phase 6C through 6V this function returned `false` unconditionally,
 * because no trustworthy positive signal existed: tags are empty on real
 * orders, `sourceName` is ambiguous, and a shipping address is only a useful
 * *negative* filter. Phase 6I then proved the point in production — native
 * SHIPPING was wrong about 29 real pickup Orders.
 *
 * What changed is not this function's caution but the input available to it.
 * OfferteApp now states the mode explicitly at quote time, and the Phase 6K
 * resolver only ever reports `DELIVERY` when an explicit, exactly-spelled
 * Stones4U signal says so AND no trustworthy native negative contradicts it.
 * A bare native SHIPPING still resolves to `UNKNOWN` and still fails here.
 *
 * Phase 6AH broadened *which* modes qualify, without softening how much
 * evidence each one needs: a resolved `CUSTOMER_PICKUP` now qualifies too,
 * because a pickup order also needs an agreed date (staff must collect and
 * prepare the goods first). `UNKNOWN` still does not qualify, and a bare
 * native SHIPPING still resolves to `UNKNOWN`.
 *
 * This function does not soften, second-guess, or re-derive the resolver's
 * answer; it only refuses to act on anything weaker than a trusted mode.
 */
function hasTrustworthyDeliveryOrderClassification(order: OrderForHandoffResult): boolean {
  return FULFILLMENT_MODES_NEEDING_DATE.has(order.fulfillmentResolution.mode);
}

/**
 * Modes for which it makes sense to ask the customer for a fulfillment date.
 *
 * **PHASE 6AH — CUSTOMER_PICKUP BELONGS HERE, AND DID NOT BEFORE.**
 *
 * The original design conflated two different questions:
 *
 *   A. "is this literally delivery transport?"
 *   B. "should we ask this customer for a date?"
 *
 * Those are not the same. A pickup order still needs an agreed day, because
 * warehouse staff must collect and prepare the goods before the customer
 * arrives. Treating CUSTOMER_PICKUP as equivalent to "no date needed" was a
 * business error, not a safety measure.
 *
 * This set answers question B only. Question A is still answered accurately by
 * `fulfillmentResolution.mode` itself, which is unchanged.
 */
const FULFILLMENT_MODES_NEEDING_DATE: ReadonlySet<FulfillmentMode> = new Set<FulfillmentMode>([
  "DELIVERY",
  "CUSTOMER_PICKUP",
]);

/** Modes that are a definite, knowable "no fulfillment date applies".
 * Separated from `UNKNOWN` so the recorded reason distinguishes "we know this
 * needs no date" from "we could not establish anything" — the two need
 * different follow-up from staff.
 *
 * NOTE ON THE NAME `NOT_A_DELIVERY_ORDER`: it predates 6AH and now means "no
 * fulfillment date applies", which is broader. It is deliberately NOT renamed
 * here — the string is persisted on ShopifyWebhookEvent.eligibilityReason, so
 * a rename is a data-migration question rather than a code one. See the report
 * for the recommendation on when to do it. */
const MODES_WITHOUT_FULFILLMENT_DATE: ReadonlySet<FulfillmentMode> = new Set<FulfillmentMode>([
  "PICKUP_POINT",
  "RETAIL",
  "NONE",
]);

/**
 * Maps the Customer's payment policy onto the decision engine's policy
 * vocabulary (build instruction §9).
 *
 * NOTE ON THE NAME `REGULAR_CONSUMER`: it predates Phase 6W and describes
 * *payment timing*, not consumer-versus-business. A BUSINESS customer with
 * `payment_policy = betaling vooraf` maps here to `REGULAR_CONSUMER` and that
 * is correct — build instruction §3 requires that BUSINESS never implies
 * ON_ACCOUNT, and this mapping is the place that guarantee holds: it reads
 * ONLY `paymentPolicy`. `customerType` is not a parameter of this function
 * and cannot influence it. The name is misleading enough to be worth
 * renaming in a later, dedicated phase; renaming it here would have churned a
 * committed, working decision engine for cosmetics.
 */
export function deliveryPolicyForPaymentPolicy(paymentPolicy: PaymentPolicy): DeliveryCustomerPolicy {
  switch (paymentPolicy) {
    case "PREPAID":
      return "REGULAR_CONSUMER";
    case "ON_ACCOUNT":
      return "B2B_ON_ACCOUNT";
    case "UNKNOWN":
      return "UNKNOWN";
  }
}

/**
 * Evaluates, in a fixed priority order (build instruction §5, revised this
 * round), whether an automatic delivery-date request is warranted right
 * now.
 *
 * 1. Cancelled Order — never.
 * 2. A requested delivery date is already known — never. **Regardless of
 *    where that date came from, and regardless of policy**: an earlier
 *    quote, the Draft Order, staff, the customer portal, a B2B agreement,
 *    or an unattributed legacy value, under UNKNOWN/REGULAR_CONSUMER/
 *    B2B_ON_ACCOUNT/MANUAL_ONLY alike. Provenance is deliberately not
 *    tracked and never inferred, and this is the rule that stops Stones4U
 *    asking a customer a question it already knows the answer to. Payment
 *    happening later never reopens this (build instruction §10).
 * 3. No shipping address — a reliable negative for a delivery request.
 * 3b. **Fulfillment classification (6W, broadened in 6AH).** The resolved
 *    Stones4U mode must be one for which a customer date is meaningful:
 *    `DELIVERY` or `CUSTOMER_PICKUP`. A pickup needs a date too — staff must
 *    collect and prepare the goods before the customer arrives. `PICKUP_POINT`,
 *    `RETAIL` and `NONE` report `NOT_A_DELIVERY_ORDER` (read: "no fulfillment
 *    date applies"); `UNKNOWN` reports `INSUFFICIENT_CLASSIFICATION`. Placed
 *    ahead of policy and payment deliberately, so an ineligible Order is never
 *    reported as merely `WAITING_FOR_PAYMENT`.
 * 4. Policy is `UNKNOWN` or `MANUAL_ONLY` — never asks automatically.
 *    `UNKNOWN` reports `INSUFFICIENT_CLASSIFICATION` (we don't know
 *    enough, not "we know this should never happen"); `MANUAL_ONLY`
 *    reports its own distinct reason. Critically, **payment is never
 *    consulted for either** — an unclassified or manual-only Order is
 *    rejected before `fullyPaid` is ever read, so it can never be
 *    mislabeled `WAITING_FOR_PAYMENT`.
 * 5. `REGULAR_CONSUMER` specifically, and only that policy, gates on
 *    `fullyPaid` — unmet payment reports `WAITING_FOR_PAYMENT`.
 * 6. `B2B_ON_ACCOUNT` is never rejected merely for being unpaid.
 * 7. No trustworthy positive classification — the conservative default.
 *    Since 6W this is reachable-past only for a resolved `DELIVERY`, so in
 *    practice step 3b already decided it; the check is kept as the single
 *    named place a future additional positive requirement would go.
 *
 * **PURE ENGINE vs RUNTIME AUTOMATION (build instruction §12).** Since Phase
 * 6W this function CAN return `READY_FOR_DELIVERY_REQUEST` — when, and only
 * when, every trusted input lines up. That is a property of this pure
 * function and says nothing about whether anything actually happens. Whether
 * a positive decision is ever *acted on* is a separate, explicit runtime
 * switch that lives in order-webhook-processing.ts and is OFF. Do not
 * conflate the two: making the engine capable of saying "yes" is what makes
 * it testable; the runtime switch is what keeps customers from being
 * contacted.
 *
 * Pure: never calls Shopify, never touches the database, never sends
 * anything. Callers persist the result; they do not re-derive it.
 *
 * `policy` is a **required** argument, not an optional one defaulting to
 * `REGULAR_CONSUMER` (a real bug found and fixed during final review this
 * round) — a future caller cannot omit it and accidentally activate
 * consumer payment semantics for an Order nobody actually classified.
 * Every webhook caller today passes `UNKNOWN` explicitly, since no
 * trustworthy classifier exists yet.
 */
export function evaluateDeliveryRequestDecision(input: {
  order: OrderForHandoffResult;
  trigger: DeliveryRequestTrigger;
  policy: DeliveryCustomerPolicy;
}): DeliveryRequestDecision {
  const { order, trigger, policy } = input;

  // Steps 1-3: the already-proven Phase 6C negatives, reused verbatim —
  // ahead of policy/payment for every policy value, no exceptions.
  const eligibility = evaluateDeliveryDateEligibility(order);
  if (eligibility.reason !== "INSUFFICIENT_CLASSIFICATION") {
    return { shouldRequest: false, reason: eligibility.reason, trigger };
  }

  // Step 3b (Phase 6W): fulfillment classification, before policy/payment.
  const fulfillmentMode = order.fulfillmentResolution.mode;
  if (MODES_WITHOUT_FULFILLMENT_DATE.has(fulfillmentMode)) {
    return { shouldRequest: false, reason: "NOT_A_DELIVERY_ORDER", trigger };
  }
  if (!FULFILLMENT_MODES_NEEDING_DATE.has(fulfillmentMode)) {
    // UNKNOWN — we could not establish anything, so we ask nobody anything.
    return { shouldRequest: false, reason: "INSUFFICIENT_CLASSIFICATION", trigger };
  }

  if (policy === "UNKNOWN") {
    return { shouldRequest: false, reason: "INSUFFICIENT_CLASSIFICATION", trigger };
  }
  if (policy === "MANUAL_ONLY") {
    return { shouldRequest: false, reason: "MANUAL_ONLY_POLICY", trigger };
  }

  if (POLICY_REQUIRES_PAYMENT[policy] && !order.fullyPaid) {
    return { shouldRequest: false, reason: "WAITING_FOR_PAYMENT", trigger };
  }

  if (!hasTrustworthyDeliveryOrderClassification(order)) {
    return { shouldRequest: false, reason: "INSUFFICIENT_CLASSIFICATION", trigger };
  }

  return { shouldRequest: true, reason: "READY_FOR_DELIVERY_REQUEST", trigger };
}
