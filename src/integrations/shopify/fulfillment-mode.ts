// Phase 6H — typed classification of a Shopify Order's fulfillment mode,
// derived from FulfillmentOrder.deliveryMethod.methodType (live-verified
// against stones4u-dev.myshopify.com: SHIPPING, LOCAL, PICK_UP, PICKUP_POINT,
// RETAIL, NONE are all real, current values of the DeliveryMethodType enum
// — see docs/ORDER-DELIVERY-HANDOFF-FOUNDATION.md §"Fulfillment mode" for
// the full verification record).
//
// This mapping corrects a wrong assumption from the prior round, which
// proposed collapsing PICK_UP/LOCAL/PICKUP_POINT/RETAIL into one PICKUP
// bucket. Per Shopify's own documented semantics, LOCAL means "delivered
// via local delivery" — it is a delivery, not a pickup — while PICK_UP
// (customer collects) and PICKUP_POINT (delivered to a third-party pickup
// point) are genuinely different from each other and from RETAIL (in-store
// sale, no delivery leg at all). Keeping all six Shopify-native values
// distinct here is deliberate: collapsing them early would destroy
// information a future delivery-date decision rule needs.
//
// Lives in integrations/shopify (not modules/delivery) because
// order-for-handoff.ts, an integrations-layer file, needs to call it, and
// this repo's module boundary (CLAUDE.md) forbids integrations depending on
// modules. This is a pure Shopify-enum mapping with no business/decision
// logic — the decision layer (modules/delivery) is expected to depend on
// this, never the reverse.
export type ShopifyDeliveryMethodType = "SHIPPING" | "LOCAL" | "PICK_UP" | "PICKUP_POINT" | "RETAIL" | "NONE";

/** Stones4U's internal fulfillment classification. `UNKNOWN` covers both
 * "no FulfillmentOrder exists yet on this Order" and "a FulfillmentOrder
 * exists but has no deliveryMethod" — both mean "insufficient information",
 * never a silent default to DELIVERY or NONE. */
export type FulfillmentMode = "DELIVERY" | "CUSTOMER_PICKUP" | "PICKUP_POINT" | "RETAIL" | "NONE" | "UNKNOWN";

const METHOD_TYPE_TO_FULFILLMENT_MODE: Record<ShopifyDeliveryMethodType, FulfillmentMode> = {
  SHIPPING: "DELIVERY",
  LOCAL: "DELIVERY",
  PICK_UP: "CUSTOMER_PICKUP",
  PICKUP_POINT: "PICKUP_POINT",
  RETAIL: "RETAIL",
  NONE: "NONE",
};

/**
 * Pure mapping from Shopify's `DeliveryMethodType` to Stones4U's internal
 * `FulfillmentMode`. `methodType` is `null`/`undefined` whenever the Order
 * has no FulfillmentOrder yet, or a FulfillmentOrder with no deliveryMethod
 * — both read as `UNKNOWN`, never inferred as any specific mode.
 *
 * This function does not decide whether a delivery-date request should be
 * sent — see modules/delivery/delivery-request-decision.ts's own doc
 * comment for how FulfillmentMode is expected to feed that decision in a
 * later phase.
 */
export function classifyFulfillmentMode(methodType: ShopifyDeliveryMethodType | string | null | undefined): FulfillmentMode {
  if (methodType == null) return "UNKNOWN";
  return METHOD_TYPE_TO_FULFILLMENT_MODE[methodType as ShopifyDeliveryMethodType] ?? "UNKNOWN";
}

/**
 * Aggregates every FulfillmentOrder on one Order into a single, deterministic
 * FulfillmentMode.
 *
 * An Order can legitimately carry several FulfillmentOrders (split
 * fulfillment across locations). Classifying on the first one alone would let
 * a genuinely mixed Order — part shipped, part collected in store — read as a
 * plain `DELIVERY`, and a mixed Order is exactly the case that must never
 * silently receive an automatic delivery-date request.
 *
 * Rules, applied in this order:
 * 1. `hasUnreadFulfillmentOrders` — the connection was truncated, so an
 *    unseen FulfillmentOrder could disagree with everything read. `UNKNOWN`,
 *    whatever the visible ones say.
 * 2. No FulfillmentOrders at all — nothing to classify. `UNKNOWN`.
 * 3. Every FulfillmentOrder agrees on one mode — that mode. Agreement is
 *    judged on the mapped `FulfillmentMode`, not the raw Shopify value, so an
 *    Order split across `SHIPPING` and `LOCAL` agrees on `DELIVERY` and stays
 *    `DELIVERY`.
 * 4. Any disagreement — `UNKNOWN`. A FulfillmentOrder with no deliveryMethod
 *    maps to `UNKNOWN` and therefore disagrees with any classified sibling;
 *    that is the intended conservative outcome, not an oversight.
 *
 * `hasUnreadFulfillmentOrders` is deliberately required rather than
 * defaulting to `false`: a caller that forgets it would silently opt into the
 * unsafe reading. Same reasoning as `evaluateDeliveryRequestDecision()`'s
 * required `policy` argument (Phase 6F final review).
 */
export function aggregateFulfillmentMode(input: {
  methodTypes: (ShopifyDeliveryMethodType | string | null | undefined)[];
  hasUnreadFulfillmentOrders: boolean;
}): FulfillmentMode {
  const { methodTypes, hasUnreadFulfillmentOrders } = input;

  if (hasUnreadFulfillmentOrders) return "UNKNOWN";
  if (methodTypes.length === 0) return "UNKNOWN";

  const distinctModes = new Set(methodTypes.map(classifyFulfillmentMode));
  if (distinctModes.size !== 1) return "UNKNOWN";

  const [onlyMode] = distinctModes;
  return onlyMode ?? "UNKNOWN";
}
