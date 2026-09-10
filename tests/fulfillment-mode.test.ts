import { describe, expect, it } from "vitest";
import { aggregateFulfillmentMode, classifyFulfillmentMode } from "@/integrations/shopify/fulfillment-mode";

// Phase 6H — pure mapping tests for classifyFulfillmentMode(). Live-verified
// against stones4u-dev.myshopify.com (staging): SHIPPING and NONE were
// directly observed via FulfillmentOrder.deliveryMethod.methodType on real
// synthetic Orders; PICK_UP, LOCAL, PICKUP_POINT and RETAIL could not be
// triggered live within this round's granted scopes (no read_locations-
// family scope), so their mapping is asserted here against Shopify's
// documented DeliveryMethodType semantics rather than a live observation —
// see docs/ORDER-DELIVERY-HANDOFF-FOUNDATION.md §"Fulfillment mode" for the
// full record of what was and wasn't live-confirmed.
describe("classifyFulfillmentMode", () => {
  it("SHIPPING -> DELIVERY (live-confirmed: staging Order #1032/#1033, requiresShipping=true)", () => {
    expect(classifyFulfillmentMode("SHIPPING")).toBe("DELIVERY");
  });

  it("LOCAL -> DELIVERY (regression test — Phase 6G incorrectly proposed LOCAL -> CUSTOMER_PICKUP; Shopify's own docs define LOCAL as local delivery, not pickup)", () => {
    expect(classifyFulfillmentMode("LOCAL")).toBe("DELIVERY");
  });

  it("PICK_UP -> CUSTOMER_PICKUP (customer collects the order)", () => {
    expect(classifyFulfillmentMode("PICK_UP")).toBe("CUSTOMER_PICKUP");
  });

  it("PICKUP_POINT -> PICKUP_POINT (delivered to a third-party pickup point — distinct from CUSTOMER_PICKUP)", () => {
    expect(classifyFulfillmentMode("PICKUP_POINT")).toBe("PICKUP_POINT");
  });

  it("RETAIL -> RETAIL (in-store sale, no delivery leg)", () => {
    expect(classifyFulfillmentMode("RETAIL")).toBe("RETAIL");
  });

  it("NONE -> NONE (live-confirmed: staging Orders #1030/#1031 before requiresShipping was set)", () => {
    expect(classifyFulfillmentMode("NONE")).toBe("NONE");
  });

  it("missing methodType (null) -> UNKNOWN, never silently DELIVERY or NONE", () => {
    expect(classifyFulfillmentMode(null)).toBe("UNKNOWN");
  });

  it("missing methodType (undefined) -> UNKNOWN", () => {
    expect(classifyFulfillmentMode(undefined)).toBe("UNKNOWN");
  });

  it("an unrecognized/future Shopify value -> UNKNOWN, never a silent guess", () => {
    expect(classifyFulfillmentMode("SOME_FUTURE_VALUE")).toBe("UNKNOWN");
  });
});

// An Order can carry several FulfillmentOrders (split fulfillment across
// locations). No split Order has been observed live on staging — every
// synthetic Order this phase produced exactly one FulfillmentOrder — so
// these cases are constructed, not live-proven. They exist because
// classifying a mixed Order on its first FulfillmentOrder alone would let a
// part-shipped/part-collected Order read as a plain DELIVERY, which is
// exactly the Order that must never receive an automatic delivery-date
// request.
describe("aggregateFulfillmentMode", () => {
  it("DELIVERY + DELIVERY -> DELIVERY", () => {
    expect(
      aggregateFulfillmentMode({ methodTypes: ["SHIPPING", "SHIPPING"], hasUnreadFulfillmentOrders: false }),
    ).toBe("DELIVERY");
  });

  it("SHIPPING + LOCAL -> DELIVERY (agreement is judged on the mapped mode, not the raw Shopify value)", () => {
    expect(aggregateFulfillmentMode({ methodTypes: ["SHIPPING", "LOCAL"], hasUnreadFulfillmentOrders: false })).toBe(
      "DELIVERY",
    );
  });

  it("PICK_UP + PICK_UP -> CUSTOMER_PICKUP", () => {
    expect(aggregateFulfillmentMode({ methodTypes: ["PICK_UP", "PICK_UP"], hasUnreadFulfillmentOrders: false })).toBe(
      "CUSTOMER_PICKUP",
    );
  });

  it("DELIVERY + PICK_UP -> UNKNOWN — a mixed Order must never read as a plain delivery", () => {
    expect(aggregateFulfillmentMode({ methodTypes: ["SHIPPING", "PICK_UP"], hasUnreadFulfillmentOrders: false })).toBe(
      "UNKNOWN",
    );
  });

  it("conflicting non-delivery modes (PICK_UP + RETAIL) -> UNKNOWN", () => {
    expect(aggregateFulfillmentMode({ methodTypes: ["PICK_UP", "RETAIL"], hasUnreadFulfillmentOrders: false })).toBe(
      "UNKNOWN",
    );
  });

  it("a classified FulfillmentOrder alongside one with no deliveryMethod -> UNKNOWN", () => {
    expect(aggregateFulfillmentMode({ methodTypes: ["SHIPPING", null], hasUnreadFulfillmentOrders: false })).toBe(
      "UNKNOWN",
    );
  });

  it("empty (no FulfillmentOrders at all) -> UNKNOWN", () => {
    expect(aggregateFulfillmentMode({ methodTypes: [], hasUnreadFulfillmentOrders: false })).toBe("UNKNOWN");
  });

  it("a single FulfillmentOrder behaves exactly like the one-value mapping", () => {
    expect(aggregateFulfillmentMode({ methodTypes: ["PICKUP_POINT"], hasUnreadFulfillmentOrders: false })).toBe(
      "PICKUP_POINT",
    );
  });

  it("a truncated connection -> UNKNOWN even when every visible FulfillmentOrder agrees", () => {
    expect(aggregateFulfillmentMode({ methodTypes: ["SHIPPING"], hasUnreadFulfillmentOrders: true })).toBe("UNKNOWN");
  });

  it("a truncated connection with nothing visible -> UNKNOWN", () => {
    expect(aggregateFulfillmentMode({ methodTypes: [], hasUnreadFulfillmentOrders: true })).toBe("UNKNOWN");
  });
});
