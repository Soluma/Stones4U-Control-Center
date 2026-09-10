import { describe, expect, it } from "vitest";
import { evaluateDeliveryRequestDecision, type DeliveryCustomerPolicy } from "@/modules/delivery/delivery-request-decision";
import type { OrderForHandoffResult } from "@/integrations/shopify/order-for-handoff";

const ALL_POLICIES: DeliveryCustomerPolicy[] = ["UNKNOWN", "REGULAR_CONSUMER", "B2B_ON_ACCOUNT", "MANUAL_ONLY"];

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

describe("evaluateDeliveryRequestDecision — policy is required, never silently REGULAR_CONSUMER (final review, this round)", () => {
  it("policy is a required argument — TypeScript itself refuses a call that omits it (this test exists to document that guarantee in prose; the real enforcement is the compiler)", () => {
    // @ts-expect-error — policy omitted on purpose, proving the type system rejects it.
    const call = () => evaluateDeliveryRequestDecision({ order: baseOrder(), trigger: "ORDER_CREATED" });
    expect(typeof call).toBe("function");
  });

  it("UNKNOWN policy, unpaid, otherwise-unremarkable Order — INSUFFICIENT_CLASSIFICATION, never WAITING_FOR_PAYMENT (the core bug this round fixes)", () => {
    const result = evaluateDeliveryRequestDecision({
      order: baseOrder({ fullyPaid: false, hasShippingAddress: true }),
      trigger: "ORDER_CREATED",
      policy: "UNKNOWN",
    });
    expect(result.reason).not.toBe("WAITING_FOR_PAYMENT");
    expect(result).toEqual({ shouldRequest: false, reason: "INSUFFICIENT_CLASSIFICATION", trigger: "ORDER_CREATED" });
  });

  it("UNKNOWN policy never consults fullyPaid at all — paid or unpaid makes no difference to the outcome", () => {
    const unpaid = evaluateDeliveryRequestDecision({ order: baseOrder({ fullyPaid: false }), trigger: "ORDER_PAID", policy: "UNKNOWN" });
    const paid = evaluateDeliveryRequestDecision({ order: baseOrder({ fullyPaid: true }), trigger: "ORDER_PAID", policy: "UNKNOWN" });
    expect(unpaid.reason).toBe("INSUFFICIENT_CLASSIFICATION");
    expect(paid.reason).toBe("INSUFFICIENT_CLASSIFICATION");
  });

  it("the exact same Order/trigger produces a different outcome depending only on explicit policy — proving UNKNOWN and REGULAR_CONSUMER are genuinely distinct code paths, not aliases", () => {
    const order = baseOrder({ fullyPaid: false, hasShippingAddress: true });
    const unknown = evaluateDeliveryRequestDecision({ order, trigger: "ORDER_CREATED", policy: "UNKNOWN" });
    const regular = evaluateDeliveryRequestDecision({ order, trigger: "ORDER_CREATED", policy: "REGULAR_CONSUMER" });
    expect(unknown.reason).toBe("INSUFFICIENT_CLASSIFICATION");
    expect(regular.reason).toBe("WAITING_FOR_PAYMENT");
    expect(unknown.reason).not.toBe(regular.reason);
  });
});

describe("evaluateDeliveryRequestDecision — priority order (build instruction §5)", () => {
  it("1. cancelled order — never, regardless of payment, policy, or anything else", () => {
    for (const policy of ALL_POLICIES) {
      const result = evaluateDeliveryRequestDecision({
        order: baseOrder({ isCancelled: true, fullyPaid: true }),
        trigger: "ORDER_PAID",
        policy,
      });
      expect(result).toEqual({ shouldRequest: false, reason: "ORDER_CANCELLED", trigger: "ORDER_PAID" });
    }
  });

  it("2. an existing requested_delivery_date suppresses the request under every policy — even paid REGULAR_CONSUMER and unpaid B2B_ON_ACCOUNT alike (build instruction §7)", () => {
    for (const policy of ALL_POLICIES) {
      const result = evaluateDeliveryRequestDecision({
        order: baseOrder({ hasRequestedDeliveryDateAlready: true, requestedDeliveryDate: "2026-09-24", fullyPaid: true }),
        trigger: "ORDER_PAID",
        policy,
      });
      expect(result).toEqual({ shouldRequest: false, reason: "ALREADY_HAS_REQUESTED_DELIVERY_DATE", trigger: "ORDER_PAID" });
    }
  });

  it("2b. existing-date suppression fires regardless of provenance — the decision has no concept of where the date came from", () => {
    const result = evaluateDeliveryRequestDecision({
      order: baseOrder({ hasRequestedDeliveryDateAlready: true, requestedDeliveryDate: "2026-01-01", fullyPaid: false }),
      trigger: "ORDER_CREATED",
      policy: "UNKNOWN",
    });
    expect(result.shouldRequest).toBe(false);
    expect(result.reason).toBe("ALREADY_HAS_REQUESTED_DELIVERY_DATE");
  });

  it("3. no shipping address — a reliable negative, checked before policy/payment, under every policy", () => {
    for (const policy of ALL_POLICIES) {
      const result = evaluateDeliveryRequestDecision({
        order: baseOrder({ hasShippingAddress: false, fullyPaid: true }),
        trigger: "ORDER_PAID",
        policy,
      });
      expect(result).toEqual({ shouldRequest: false, reason: "NO_SHIPPING_ADDRESS", trigger: "ORDER_PAID" });
    }
  });

  it("4a. UNKNOWN policy — INSUFFICIENT_CLASSIFICATION, never asks automatically, payment never consulted", () => {
    const result = evaluateDeliveryRequestDecision({
      order: baseOrder({ fullyPaid: false }),
      trigger: "ORDER_CREATED",
      policy: "UNKNOWN",
    });
    expect(result).toEqual({ shouldRequest: false, reason: "INSUFFICIENT_CLASSIFICATION", trigger: "ORDER_CREATED" });
  });

  it("4b. MANUAL_ONLY policy — its own distinct reason, never asks automatically, payment never consulted", () => {
    const result = evaluateDeliveryRequestDecision({
      order: baseOrder({ fullyPaid: true, hasShippingAddress: true }),
      trigger: "ORDER_PAID",
      policy: "MANUAL_ONLY",
    });
    expect(result).toEqual({ shouldRequest: false, reason: "MANUAL_ONLY_POLICY", trigger: "ORDER_PAID" });
  });

  it("5. REGULAR_CONSUMER, not yet paid — WAITING_FOR_PAYMENT, not a permanent rejection", () => {
    const result = evaluateDeliveryRequestDecision({
      order: baseOrder({ fullyPaid: false }),
      trigger: "ORDER_CREATED",
      policy: "REGULAR_CONSUMER",
    });
    expect(result).toEqual({ shouldRequest: false, reason: "WAITING_FOR_PAYMENT", trigger: "ORDER_CREATED" });
  });

  it("5b. REGULAR_CONSUMER, paid — still cannot become READY without a trustworthy positive delivery classification (INSUFFICIENT_CLASSIFICATION, not a false positive)", () => {
    const result = evaluateDeliveryRequestDecision({
      order: baseOrder({ fullyPaid: true, hasShippingAddress: true }),
      trigger: "ORDER_PAID",
      policy: "REGULAR_CONSUMER",
    });
    expect(result).toEqual({ shouldRequest: false, reason: "INSUFFICIENT_CLASSIFICATION", trigger: "ORDER_PAID" });
  });

  it("6. B2B_ON_ACCOUNT is never rejected merely for being unpaid — payment is not that policy's trigger", () => {
    const result = evaluateDeliveryRequestDecision({
      order: baseOrder({ fullyPaid: false }),
      trigger: "ORDER_CREATED",
      policy: "B2B_ON_ACCOUNT",
    });
    expect(result.reason).not.toBe("WAITING_FOR_PAYMENT");
    // Still lands on the conservative default — no positive rule exists for
    // B2B either; this only proves payment isn't what stops it.
    expect(result.reason).toBe("INSUFFICIENT_CLASSIFICATION");
  });

  it("shipping address presence alone is never sufficient for shouldRequest: true, even paid REGULAR_CONSUMER and otherwise unremarkable", () => {
    const result = evaluateDeliveryRequestDecision({
      order: baseOrder({ fullyPaid: true, hasShippingAddress: true, fulfillmentStatus: "UNFULFILLED" }),
      trigger: "ORDER_PAID",
      policy: "REGULAR_CONSUMER",
    });
    expect(result.shouldRequest).toBe(false);
  });

  it("never returns shouldRequest: true for any input today, under any policy — no positive classification rule exists yet", () => {
    const cases: OrderForHandoffResult[] = [
      baseOrder({ fullyPaid: true }),
      baseOrder({ fullyPaid: true, customerGid: "gid://shopify/Customer/1" }),
      baseOrder({ fullyPaid: true, fulfillmentStatus: "FULFILLED" }),
    ];
    for (const order of cases) {
      for (const policy of ALL_POLICIES) {
        expect(evaluateDeliveryRequestDecision({ order, trigger: "ORDER_PAID", policy }).shouldRequest).toBe(false);
      }
    }
  });
});

describe("evaluateDeliveryRequestDecision — policy never inferred from Order data (build instruction §3)", () => {
  it("cancellation and existing-date still win even under B2B_ON_ACCOUNT/MANUAL_ONLY — those checks run before policy is consulted", () => {
    const cancelled = evaluateDeliveryRequestDecision({
      order: baseOrder({ isCancelled: true }),
      trigger: "ORDER_PAID",
      policy: "B2B_ON_ACCOUNT",
    });
    expect(cancelled.reason).toBe("ORDER_CANCELLED");

    const hasDate = evaluateDeliveryRequestDecision({
      order: baseOrder({ hasRequestedDeliveryDateAlready: true, requestedDeliveryDate: "2026-09-24" }),
      trigger: "ORDER_PAID",
      policy: "MANUAL_ONLY",
    });
    expect(hasDate.reason).toBe("ALREADY_HAS_REQUESTED_DELIVERY_DATE");
  });

  it("a payment webhook (ORDER_PAID) with UNKNOWN policy remains conservative even though fullyPaid just became true (build instruction §8)", () => {
    const result = evaluateDeliveryRequestDecision({
      order: baseOrder({ fullyPaid: true, hasShippingAddress: true }),
      trigger: "ORDER_PAID",
      policy: "UNKNOWN",
    });
    expect(result.shouldRequest).toBe(false);
    expect(result.reason).toBe("INSUFFICIENT_CLASSIFICATION");
  });
});

describe("evaluateDeliveryRequestDecision — trigger is recorded, never re-derives the decision", () => {
  it("records whichever trigger the caller passed, unchanged", () => {
    for (const trigger of ["ORDER_CREATED", "ORDER_PAID", "STAFF_REVIEW"] as const) {
      const result = evaluateDeliveryRequestDecision({ order: baseOrder(), trigger, policy: "UNKNOWN" });
      expect(result.trigger).toBe(trigger);
    }
  });

  it("is pure — never mutates the input order object", () => {
    const order = baseOrder({ fullyPaid: true });
    const snapshot = JSON.stringify(order);
    evaluateDeliveryRequestDecision({ order, trigger: "ORDER_PAID", policy: "REGULAR_CONSUMER" });
    expect(JSON.stringify(order)).toBe(snapshot);
  });
});
