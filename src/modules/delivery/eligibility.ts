import "server-only";
import type { OrderForHandoffResult } from "@/integrations/shopify/order-for-handoff";

// Phase 6C — explicit, typed eligibility classification for whether an
// incoming Shopify Order should automatically receive a delivery-date
// handoff. Deliberately conservative: the brief for this phase is explicit
// that missing an automatic handoff is preferable to creating one for the
// wrong order (e.g. a pickup order, a cancelled order, one already
// handled). No positive/trustworthy signal for "this is a genuine,
// delivery-relevant customer order" currently exists in this codebase —
// Phase 6A discovery's live sample of real production orders found `tags`
// empty on every order and only two `sourceName` patterns
// ("shopify_draft_order" and an unidentified numeric app id), neither
// reliable enough to build a positive rule on. Until that changes (a
// tagging convention, a confirmed sourceName meaning, or another reliable
// signal), every real order falls through to INSUFFICIENT_CLASSIFICATION —
// `eligible` structurally can be `true`, but no code path currently
// produces it. This is intentional, not a bug — see
// docs/ORDER-DELIVERY-HANDOFF-FOUNDATION.md §"Eligibility engine".

export type EligibilityReason =
  | "ORDER_CANCELLED"
  | "ALREADY_HAS_REQUESTED_DELIVERY_DATE"
  | "NO_SHIPPING_ADDRESS"
  | "INSUFFICIENT_CLASSIFICATION";

export type EligibilityResult = { eligible: boolean; reason: EligibilityReason };

/**
 * Evaluates whether `order` should automatically receive a
 * DeliveryDateHandoff. Never mutates anything, never calls Shopify itself
 * — pure classification over an already-fetched OrderForHandoffResult
 * (see getOrderForHandoff()).
 *
 * Checked in order, each a hard, definitive negative:
 * 1. Cancelled — never eligible, no matter what else is true.
 * 2. Already has a requested_delivery_date attribute — never overwrite an
 *    existing customer response by creating a second, competing handoff.
 * 3. No shipping address — a real, if incomplete, negative signal
 *    (Phase 6A discovery: 100% correlation with a non-draft-based order
 *    source in a live sample, consistent with a pickup/no-delivery order)
 *    — but presence of a shipping address is NOT treated as a positive
 *    signal on its own (see module doc comment above).
 *
 * Anything that survives all three checks still falls through to
 * INSUFFICIENT_CLASSIFICATION today.
 */
export function evaluateDeliveryDateEligibility(order: OrderForHandoffResult): EligibilityResult {
  if (order.isCancelled) {
    return { eligible: false, reason: "ORDER_CANCELLED" };
  }
  if (order.hasRequestedDeliveryDateAlready) {
    return { eligible: false, reason: "ALREADY_HAS_REQUESTED_DELIVERY_DATE" };
  }
  if (!order.hasShippingAddress) {
    return { eligible: false, reason: "NO_SHIPPING_ADDRESS" };
  }
  return { eligible: false, reason: "INSUFFICIENT_CLASSIFICATION" };
}
