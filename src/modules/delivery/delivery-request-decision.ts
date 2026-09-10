import "server-only";
import type { OrderForHandoffResult } from "@/integrations/shopify/order-for-handoff";
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
 * Whether this Order is *positively* known to be a genuine, delivery-bound
 * customer order that Stones4U should proactively ask a date for.
 *
 * Still `false` for everything (build instruction §16). Phase 6A discovery
 * and the Phase 6C/6F re-checks found no trustworthy positive signal: tags
 * are empty on real orders, `sourceName` values are ambiguous, and a
 * shipping address is only a useful *negative* filter — its presence alone
 * proves nothing about whether this is a regular delivery order, a
 * staff-created one, or something else. A paid Order with a shipping
 * address and no delivery date must therefore still NOT silently become
 * eligible; it lands on INSUFFICIENT_CLASSIFICATION, which is the correct,
 * accepted outcome until a real signal exists. This function is the single
 * place a future positive rule gets added — it will need to inspect the
 * Order at that point, so its signature is expected to grow a parameter
 * then, not now.
 */
function hasTrustworthyDeliveryOrderClassification(): boolean {
  return false;
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
 *    asking a customer a question it already knows the answer to.
 * 3. No shipping address — a reliable negative for a delivery request.
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
 * 7. No trustworthy positive classification — the conservative default,
 *    and where every real Order still lands today regardless of policy.
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

  if (policy === "UNKNOWN") {
    return { shouldRequest: false, reason: "INSUFFICIENT_CLASSIFICATION", trigger };
  }
  if (policy === "MANUAL_ONLY") {
    return { shouldRequest: false, reason: "MANUAL_ONLY_POLICY", trigger };
  }

  if (POLICY_REQUIRES_PAYMENT[policy] && !order.fullyPaid) {
    return { shouldRequest: false, reason: "WAITING_FOR_PAYMENT", trigger };
  }

  if (!hasTrustworthyDeliveryOrderClassification()) {
    return { shouldRequest: false, reason: "INSUFFICIENT_CLASSIFICATION", trigger };
  }

  return { shouldRequest: true, reason: "READY_FOR_DELIVERY_REQUEST", trigger };
}
