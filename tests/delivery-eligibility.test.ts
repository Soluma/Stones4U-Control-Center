import { describe, expect, it } from "vitest";
import { evaluateDeliveryDateEligibility } from "@/modules/delivery/eligibility";
import type { OrderForHandoffResult } from "@/integrations/shopify/order-for-handoff";

function baseOrder(overrides: Partial<OrderForHandoffResult> = {}): OrderForHandoffResult {
  return {
    gid: "gid://shopify/Order/1",
    name: "#1000",
    isCancelled: false,
    fulfillmentStatus: "UNFULFILLED",
    customerGid: null,
    hasShippingAddress: true,
    hasRequestedDeliveryDateAlready: false,
    requestedDeliveryDate: null,
    fullyPaid: false,
    ...overrides,
  };
}

describe("evaluateDeliveryDateEligibility", () => {
  it("cancelled order is never eligible, regardless of anything else", () => {
    const result = evaluateDeliveryDateEligibility(baseOrder({ isCancelled: true }));
    expect(result).toEqual({ eligible: false, reason: "ORDER_CANCELLED" });
  });

  it("an order that already has a requested delivery date is not eligible", () => {
    const result = evaluateDeliveryDateEligibility(baseOrder({ hasRequestedDeliveryDateAlready: true }));
    expect(result).toEqual({ eligible: false, reason: "ALREADY_HAS_REQUESTED_DELIVERY_DATE" });
  });

  it("an order without a shipping address is not eligible", () => {
    const result = evaluateDeliveryDateEligibility(baseOrder({ hasShippingAddress: false }));
    expect(result).toEqual({ eligible: false, reason: "NO_SHIPPING_ADDRESS" });
  });

  it("an order with a shipping address, not cancelled, no existing date — still not eligible (insufficient classification, conservative default)", () => {
    const result = evaluateDeliveryDateEligibility(baseOrder());
    expect(result).toEqual({ eligible: false, reason: "INSUFFICIENT_CLASSIFICATION" });
  });

  it("cancellation is checked before the shipping-address check — a cancelled order with no shipping address still reports ORDER_CANCELLED, not NO_SHIPPING_ADDRESS", () => {
    const result = evaluateDeliveryDateEligibility(baseOrder({ isCancelled: true, hasShippingAddress: false }));
    expect(result.reason).toBe("ORDER_CANCELLED");
  });

  it("no synthetic/test-order special case exists — a synthetic order is classified the same as any other (INSUFFICIENT_CLASSIFICATION when otherwise unremarkable)", () => {
    const result = evaluateDeliveryDateEligibility(baseOrder({ name: "#TEST-SYNTHETIC" }));
    expect(result.reason).toBe("INSUFFICIENT_CLASSIFICATION");
  });

  it("never returns eligible: true for any input in this phase — no positive rule exists yet (see eligibility.ts doc comment)", () => {
    const cases: OrderForHandoffResult[] = [
      baseOrder(),
      baseOrder({ hasShippingAddress: true, fulfillmentStatus: "FULFILLED" }),
      baseOrder({ customerGid: "gid://shopify/Customer/1" }),
    ];
    for (const order of cases) {
      expect(evaluateDeliveryDateEligibility(order).eligible).toBe(false);
    }
  });
});
