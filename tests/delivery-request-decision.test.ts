import { describe, expect, it } from "vitest";
import {
  deliveryPolicyForPaymentPolicy,
  evaluateDeliveryRequestDecision,
  type DeliveryCustomerPolicy,
} from "@/modules/delivery/delivery-request-decision";
import type { OrderForHandoffResult } from "@/integrations/shopify/order-for-handoff";
import type { FulfillmentMode } from "@/integrations/shopify/fulfillment-mode";
import {
  unclassifiedCustomer,
  type ClassificationReadState,
  type ClassificationValueSource,
  type CustomerType,
  type PaymentPolicy,
} from "@/integrations/shopify/customer-classification";

const ALL_POLICIES: DeliveryCustomerPolicy[] = ["UNKNOWN", "REGULAR_CONSUMER", "B2B_ON_ACCOUNT", "MANUAL_ONLY"];

/** A classification as an EXPLICITLY stated one. Phase 6AD: passing UNKNOWN
 * here means "the stored value could not be trusted" (INVALID), not "nothing
 * was stored" — an absent value now defaults to PREPAID/CONSUMER, so the two
 * can no longer share a fixture. */
function classification(paymentPolicy: PaymentPolicy, customerType: CustomerType = "UNKNOWN") {
  return {
    paymentPolicy,
    customerType,
    source: "CUSTOMER_METAFIELDS" as const,
    paymentPolicyStatus: (paymentPolicy === "UNKNOWN" ? "INVALID" : "VALID") as ClassificationReadState,
    customerTypeStatus: (customerType === "UNKNOWN" ? "INVALID" : "VALID") as ClassificationReadState,
    paymentPolicySource: (paymentPolicy === "UNKNOWN" ? "FAIL_CLOSED" : "EXPLICIT") as ClassificationValueSource,
    customerTypeSource: (customerType === "UNKNOWN" ? "FAIL_CLOSED" : "EXPLICIT") as ClassificationValueSource,
  };
}

/** Phase 6AD — a real customer with nothing stored: the ordinary case, which
 * now resolves to the CONSUMER + PREPAID defaults. */
function defaultedClassification() {
  return {
    paymentPolicy: "PREPAID" as PaymentPolicy,
    customerType: "CONSUMER" as CustomerType,
    source: "CUSTOMER_METAFIELDS" as const,
    paymentPolicyStatus: "ABSENT" as ClassificationReadState,
    customerTypeStatus: "ABSENT" as ClassificationReadState,
    paymentPolicySource: "DEFAULT" as ClassificationValueSource,
    customerTypeSource: "DEFAULT" as ClassificationValueSource,
  };
}

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
    nativeFulfillmentMode: "UNKNOWN",
    explicitFulfillmentMode: null,
    // Deliberately UNKNOWN by default — an Order nobody classified is the
    // historical norm, and must stay the conservative default in tests too.
    fulfillmentResolution: { mode: "UNKNOWN", source: "NONE", conflict: false, diagnostic: "NONE" },
    customerClassification: unclassifiedCustomer("NO_CUSTOMER"),
    ...overrides,
  };
}

/** An Order whose Stones4U fulfillment mode resolved to a trusted DELIVERY —
 * i.e. OfferteApp explicitly said so and no native negative contradicted it. */
function deliveryOrder(overrides: Partial<OrderForHandoffResult> = {}): OrderForHandoffResult {
  return baseOrder({
    explicitFulfillmentMode: "DELIVERY",
    nativeFulfillmentMode: "DELIVERY",
    fulfillmentResolution: { mode: "DELIVERY", source: "EXPLICIT", conflict: false, diagnostic: "NONE" },
    ...overrides,
  });
}

function resolvedAs(mode: FulfillmentMode, overrides: Partial<OrderForHandoffResult> = {}): OrderForHandoffResult {
  return baseOrder({
    fulfillmentResolution: { mode, source: mode === "UNKNOWN" ? "NONE" : "EXPLICIT", conflict: false, diagnostic: "NONE" },
    ...overrides,
  });
}

describe("evaluateDeliveryRequestDecision — policy is required, never silently REGULAR_CONSUMER", () => {
  it("policy is a required argument — TypeScript itself refuses a call that omits it (this test exists to document that guarantee in prose; the real enforcement is the compiler)", () => {
    // @ts-expect-error — policy omitted on purpose, proving the type system rejects it.
    const call = () => evaluateDeliveryRequestDecision({ order: baseOrder(), trigger: "ORDER_CREATED" });
    expect(typeof call).toBe("function");
  });

  it("UNKNOWN policy, unpaid, otherwise-unremarkable delivery Order — INSUFFICIENT_CLASSIFICATION, never WAITING_FOR_PAYMENT", () => {
    const result = evaluateDeliveryRequestDecision({
      order: deliveryOrder({ fullyPaid: false, hasShippingAddress: true }),
      trigger: "ORDER_CREATED",
      policy: "UNKNOWN",
    });
    expect(result.reason).not.toBe("WAITING_FOR_PAYMENT");
    expect(result).toEqual({ shouldRequest: false, reason: "INSUFFICIENT_CLASSIFICATION", trigger: "ORDER_CREATED" });
  });

  it("UNKNOWN policy never consults fullyPaid at all — paid or unpaid makes no difference to the outcome", () => {
    const unpaid = evaluateDeliveryRequestDecision({ order: deliveryOrder({ fullyPaid: false }), trigger: "ORDER_PAID", policy: "UNKNOWN" });
    const paid = evaluateDeliveryRequestDecision({ order: deliveryOrder({ fullyPaid: true }), trigger: "ORDER_PAID", policy: "UNKNOWN" });
    expect(unpaid.reason).toBe("INSUFFICIENT_CLASSIFICATION");
    expect(paid.reason).toBe("INSUFFICIENT_CLASSIFICATION");
  });

  it("the exact same Order/trigger produces a different outcome depending only on explicit policy — proving UNKNOWN and REGULAR_CONSUMER are genuinely distinct code paths, not aliases", () => {
    const order = deliveryOrder({ fullyPaid: false, hasShippingAddress: true });
    const unknown = evaluateDeliveryRequestDecision({ order, trigger: "ORDER_CREATED", policy: "UNKNOWN" });
    const regular = evaluateDeliveryRequestDecision({ order, trigger: "ORDER_CREATED", policy: "REGULAR_CONSUMER" });
    expect(unknown.reason).toBe("INSUFFICIENT_CLASSIFICATION");
    expect(regular.reason).toBe("WAITING_FOR_PAYMENT");
    expect(unknown.reason).not.toBe(regular.reason);
  });
});

describe("evaluateDeliveryRequestDecision — priority order (Phase 6W build instruction §11)", () => {
  it("1. cancelled order — never, regardless of payment, policy, fulfillment mode, or anything else", () => {
    for (const policy of ALL_POLICIES) {
      const result = evaluateDeliveryRequestDecision({
        order: deliveryOrder({ isCancelled: true, fullyPaid: true }),
        trigger: "ORDER_PAID",
        policy,
      });
      expect(result).toEqual({ shouldRequest: false, reason: "ORDER_CANCELLED", trigger: "ORDER_PAID" });
    }
  });

  it("2. an existing requested_delivery_date suppresses the request under every policy — even paid REGULAR_CONSUMER on a trusted DELIVERY Order", () => {
    for (const policy of ALL_POLICIES) {
      const result = evaluateDeliveryRequestDecision({
        order: deliveryOrder({ hasRequestedDeliveryDateAlready: true, requestedDeliveryDate: "2026-09-24", fullyPaid: true }),
        trigger: "ORDER_PAID",
        policy,
      });
      expect(result).toEqual({ shouldRequest: false, reason: "ALREADY_HAS_REQUESTED_DELIVERY_DATE", trigger: "ORDER_PAID" });
    }
  });

  it("2b. existing-date suppression fires regardless of provenance — the decision has no concept of where the date came from", () => {
    const result = evaluateDeliveryRequestDecision({
      order: deliveryOrder({ hasRequestedDeliveryDateAlready: true, requestedDeliveryDate: "2026-01-01", fullyPaid: false }),
      trigger: "ORDER_CREATED",
      policy: "UNKNOWN",
    });
    expect(result.shouldRequest).toBe(false);
    expect(result.reason).toBe("ALREADY_HAS_REQUESTED_DELIVERY_DATE");
  });

  it("2c. payment completing later never reopens a suppressed Order (build instruction §10)", () => {
    const order = deliveryOrder({
      hasRequestedDeliveryDateAlready: true,
      requestedDeliveryDate: "2026-09-24",
      fullyPaid: true,
      customerClassification: classification("PREPAID", "CONSUMER"),
    });
    const result = evaluateDeliveryRequestDecision({ order, trigger: "ORDER_PAID", policy: "REGULAR_CONSUMER" });
    expect(result.reason).toBe("ALREADY_HAS_REQUESTED_DELIVERY_DATE");
  });

  it("3. no shipping address — a reliable negative, checked before fulfillment/policy/payment, under every policy", () => {
    for (const policy of ALL_POLICIES) {
      const result = evaluateDeliveryRequestDecision({
        order: deliveryOrder({ hasShippingAddress: false, fullyPaid: true }),
        trigger: "ORDER_PAID",
        policy,
      });
      expect(result).toEqual({ shouldRequest: false, reason: "NO_SHIPPING_ADDRESS", trigger: "ORDER_PAID" });
    }
  });

  it("4a. UNKNOWN policy — INSUFFICIENT_CLASSIFICATION, never asks automatically, payment never consulted", () => {
    const result = evaluateDeliveryRequestDecision({
      order: deliveryOrder({ fullyPaid: false }),
      trigger: "ORDER_CREATED",
      policy: "UNKNOWN",
    });
    expect(result).toEqual({ shouldRequest: false, reason: "INSUFFICIENT_CLASSIFICATION", trigger: "ORDER_CREATED" });
  });

  it("4b. MANUAL_ONLY policy — its own distinct reason, never asks automatically, payment never consulted", () => {
    const result = evaluateDeliveryRequestDecision({
      order: deliveryOrder({ fullyPaid: true, hasShippingAddress: true }),
      trigger: "ORDER_PAID",
      policy: "MANUAL_ONLY",
    });
    expect(result).toEqual({ shouldRequest: false, reason: "MANUAL_ONLY_POLICY", trigger: "ORDER_PAID" });
  });

  it("5. REGULAR_CONSUMER, not yet paid — WAITING_FOR_PAYMENT, not a permanent rejection", () => {
    const result = evaluateDeliveryRequestDecision({
      order: deliveryOrder({ fullyPaid: false }),
      trigger: "ORDER_CREATED",
      policy: "REGULAR_CONSUMER",
    });
    expect(result).toEqual({ shouldRequest: false, reason: "WAITING_FOR_PAYMENT", trigger: "ORDER_CREATED" });
  });

  it("6. B2B_ON_ACCOUNT is never rejected merely for being unpaid — payment is not that policy's trigger", () => {
    const result = evaluateDeliveryRequestDecision({
      order: deliveryOrder({ fullyPaid: false }),
      trigger: "ORDER_CREATED",
      policy: "B2B_ON_ACCOUNT",
    });
    expect(result.reason).not.toBe("WAITING_FOR_PAYMENT");
    expect(result.reason).toBe("READY_FOR_DELIVERY_REQUEST");
  });
});

describe("evaluateDeliveryRequestDecision — fulfillment gate (Phase 6W build instruction §8)", () => {
  it("every mode for which no fulfillment date applies blocks the request, even paid and fully classified", () => {
    // Phase 6AH — CUSTOMER_PICKUP is deliberately NOT in this list any more:
    // a pickup needs a date too. These three genuinely need none.
    for (const mode of ["PICKUP_POINT", "RETAIL", "NONE"] as const) {
      const result = evaluateDeliveryRequestDecision({
        order: resolvedAs(mode, { fullyPaid: true, customerClassification: classification("PREPAID", "CONSUMER") }),
        trigger: "ORDER_PAID",
        policy: "REGULAR_CONSUMER",
      });
      expect(result).toEqual({ shouldRequest: false, reason: "NOT_A_DELIVERY_ORDER", trigger: "ORDER_PAID" });
    }
  });

  it("UNKNOWN fulfillment blocks the request and is reported as INSUFFICIENT_CLASSIFICATION, not NOT_A_DELIVERY_ORDER — 'we don't know' and 'we know it's a pickup' stay distinct", () => {
    const result = evaluateDeliveryRequestDecision({
      order: resolvedAs("UNKNOWN", { fullyPaid: true }),
      trigger: "ORDER_PAID",
      policy: "REGULAR_CONSUMER",
    });
    expect(result).toEqual({ shouldRequest: false, reason: "INSUFFICIENT_CLASSIFICATION", trigger: "ORDER_PAID" });
  });

  it("the fulfillment gate runs BEFORE the payment gate — an unpaid RETAIL Order is NOT_A_DELIVERY_ORDER, never WAITING_FOR_PAYMENT", () => {
    const result = evaluateDeliveryRequestDecision({
      order: resolvedAs("RETAIL", { fullyPaid: false }),
      trigger: "ORDER_CREATED",
      policy: "REGULAR_CONSUMER",
    });
    expect(result.reason).toBe("NOT_A_DELIVERY_ORDER");
  });

  // Phase 6AH — the correction itself.
  it("CUSTOMER_PICKUP is date-request eligible: staff must prepare the goods before the customer arrives", () => {
    const result = evaluateDeliveryRequestDecision({
      order: resolvedAs("CUSTOMER_PICKUP", {
        fullyPaid: true,
        customerClassification: classification("PREPAID", "CONSUMER"),
      }),
      trigger: "ORDER_PAID",
      policy: "REGULAR_CONSUMER",
    });
    expect(result).toEqual({
      shouldRequest: true,
      reason: "READY_FOR_DELIVERY_REQUEST",
      trigger: "ORDER_PAID",
    });
  });

  it("an unpaid PREPAID pickup waits for payment, exactly like a delivery would", () => {
    const result = evaluateDeliveryRequestDecision({
      order: resolvedAs("CUSTOMER_PICKUP", { fullyPaid: false }),
      trigger: "ORDER_CREATED",
      policy: "REGULAR_CONSUMER",
    });
    expect(result.reason).toBe("WAITING_FOR_PAYMENT");
  });

  it("an existing date suppresses a pickup request just as it does a delivery one", () => {
    const result = evaluateDeliveryRequestDecision({
      order: resolvedAs("CUSTOMER_PICKUP", {
        fullyPaid: true,
        hasRequestedDeliveryDateAlready: true,
        requestedDeliveryDate: "2027-03-16",
        customerClassification: classification("PREPAID", "CONSUMER"),
      }),
      trigger: "ORDER_PAID",
      policy: "REGULAR_CONSUMER",
    });
    expect(result.reason).toBe("ALREADY_HAS_REQUESTED_DELIVERY_DATE");
  });

  it("ON_ACCOUNT pickup is not blocked merely for being unpaid", () => {
    const order = resolvedAs("CUSTOMER_PICKUP", {
      fullyPaid: false,
      customerClassification: classification("ON_ACCOUNT", "BUSINESS"),
    });
    const result = evaluateDeliveryRequestDecision({
      order,
      trigger: "ORDER_CREATED",
      policy: deliveryPolicyForPaymentPolicy(order.customerClassification.paymentPolicy),
    });
    expect(result.reason).not.toBe("WAITING_FOR_PAYMENT");
    expect(result.reason).toBe("READY_FOR_DELIVERY_REQUEST");
  });

  it("a bare native SHIPPING that never resolved is still not enough — the Phase 6I production lesson stays enforced", () => {
    const nativeOnly = baseOrder({
      nativeFulfillmentMode: "DELIVERY",
      explicitFulfillmentMode: null,
      // What resolveFulfillmentMode() actually returns for untrusted native SHIPPING.
      fulfillmentResolution: { mode: "UNKNOWN", source: "NONE", conflict: false, diagnostic: "NATIVE_NOT_TRUSTED" },
      fullyPaid: true,
      customerClassification: classification("PREPAID"),
    });
    const result = evaluateDeliveryRequestDecision({ order: nativeOnly, trigger: "ORDER_PAID", policy: "REGULAR_CONSUMER" });
    expect(result.shouldRequest).toBe(false);
    expect(result.reason).toBe("INSUFFICIENT_CLASSIFICATION");
  });

  it("shipping address presence alone is never sufficient — an unclassified Order with an address stays blocked", () => {
    const result = evaluateDeliveryRequestDecision({
      order: baseOrder({ fullyPaid: true, hasShippingAddress: true, fulfillmentStatus: "UNFULFILLED" }),
      trigger: "ORDER_PAID",
      policy: "REGULAR_CONSUMER",
    });
    expect(result.shouldRequest).toBe(false);
  });
});

describe("evaluateDeliveryRequestDecision — payment policy mapping (build instruction §3/§9)", () => {
  it("maps each PaymentPolicy to exactly one decision policy, and nothing else", () => {
    expect(deliveryPolicyForPaymentPolicy("PREPAID")).toBe("REGULAR_CONSUMER");
    expect(deliveryPolicyForPaymentPolicy("ON_ACCOUNT")).toBe("B2B_ON_ACCOUNT");
    expect(deliveryPolicyForPaymentPolicy("UNKNOWN")).toBe("UNKNOWN");
  });

  it("customer_type NEVER changes the outcome — BUSINESS+PREPAID behaves exactly like CONSUMER+PREPAID", () => {
    const business = deliveryOrder({ fullyPaid: false, customerClassification: classification("PREPAID", "BUSINESS") });
    const consumer = deliveryOrder({ fullyPaid: false, customerClassification: classification("PREPAID", "CONSUMER") });
    const b = evaluateDeliveryRequestDecision({ order: business, trigger: "ORDER_CREATED", policy: deliveryPolicyForPaymentPolicy(business.customerClassification.paymentPolicy) });
    const c = evaluateDeliveryRequestDecision({ order: consumer, trigger: "ORDER_CREATED", policy: deliveryPolicyForPaymentPolicy(consumer.customerClassification.paymentPolicy) });
    expect(b.reason).toBe("WAITING_FOR_PAYMENT");
    expect(c.reason).toBe("WAITING_FOR_PAYMENT");
    expect(b).toEqual(c);
  });

  it("BUSINESS never implies ON_ACCOUNT — a BUSINESS customer marked PREPAID still waits for payment", () => {
    const order = deliveryOrder({ fullyPaid: false, customerClassification: classification("PREPAID", "BUSINESS") });
    const result = evaluateDeliveryRequestDecision({
      order,
      trigger: "ORDER_CREATED",
      policy: deliveryPolicyForPaymentPolicy(order.customerClassification.paymentPolicy),
    });
    expect(result.reason).toBe("WAITING_FOR_PAYMENT");
    expect(result.reason).not.toBe("READY_FOR_DELIVERY_REQUEST");
  });
});

// Phase 6W build instruction §23 — the deterministic matrix, case for case.
describe("evaluateDeliveryRequestDecision — build instruction §23 decision matrix", () => {
  function decide(order: OrderForHandoffResult) {
    return evaluateDeliveryRequestDecision({
      order,
      trigger: "ORDER_PAID",
      policy: deliveryPolicyForPaymentPolicy(order.customerClassification.paymentPolicy),
    });
  }

  it("A. DELIVERY + PREPAID + paid + no date -> READY candidate", () => {
    const result = decide(deliveryOrder({ fullyPaid: true, customerClassification: classification("PREPAID", "CONSUMER") }));
    expect(result).toEqual({ shouldRequest: true, reason: "READY_FOR_DELIVERY_REQUEST", trigger: "ORDER_PAID" });
  });

  it("B. DELIVERY + PREPAID + not paid + no date -> WAITING_FOR_PAYMENT", () => {
    const result = decide(deliveryOrder({ fullyPaid: false, customerClassification: classification("PREPAID", "CONSUMER") }));
    expect(result.reason).toBe("WAITING_FOR_PAYMENT");
    expect(result.shouldRequest).toBe(false);
  });

  it("C. DELIVERY + ON_ACCOUNT + not paid + no date -> proceeds past the payment gate", () => {
    const result = decide(deliveryOrder({ fullyPaid: false, customerClassification: classification("ON_ACCOUNT", "BUSINESS") }));
    expect(result.reason).not.toBe("WAITING_FOR_PAYMENT");
    expect(result).toEqual({ shouldRequest: true, reason: "READY_FOR_DELIVERY_REQUEST", trigger: "ORDER_PAID" });
  });

  it("D. (revised in 6AH) CUSTOMER_PICKUP + PREPAID + paid + no date -> READY, because a pickup needs a date too", () => {
    const result = decide(resolvedAs("CUSTOMER_PICKUP", { fullyPaid: true, customerClassification: classification("PREPAID", "CONSUMER") }));
    expect(result.shouldRequest).toBe(true);
    expect(result.reason).toBe("READY_FOR_DELIVERY_REQUEST");
  });

  it("D2. NONE + PREPAID + paid -> still no request, since no date applies", () => {
    const result = decide(resolvedAs("NONE", { fullyPaid: true, customerClassification: classification("PREPAID", "CONSUMER") }));
    expect(result.shouldRequest).toBe(false);
    expect(result.reason).toBe("NOT_A_DELIVERY_ORDER");
  });

  it("E. DELIVERY + UNKNOWN payment policy + paid -> INSUFFICIENT_CLASSIFICATION", () => {
    const result = decide(deliveryOrder({ fullyPaid: true, customerClassification: classification("UNKNOWN") }));
    expect(result.shouldRequest).toBe(false);
    expect(result.reason).toBe("INSUFFICIENT_CLASSIFICATION");
  });

  it("F. UNKNOWN fulfillment + PREPAID + paid -> INSUFFICIENT_CLASSIFICATION", () => {
    const result = decide(resolvedAs("UNKNOWN", { fullyPaid: true, customerClassification: classification("PREPAID", "CONSUMER") }));
    expect(result.shouldRequest).toBe(false);
    expect(result.reason).toBe("INSUFFICIENT_CLASSIFICATION");
  });

  it("G. DELIVERY + PREPAID + paid + requested date exists -> ALREADY_HAS_REQUESTED_DELIVERY_DATE", () => {
    const result = decide(
      deliveryOrder({
        fullyPaid: true,
        hasRequestedDeliveryDateAlready: true,
        requestedDeliveryDate: "2026-09-24",
        customerClassification: classification("PREPAID", "CONSUMER"),
      }),
    );
    expect(result.shouldRequest).toBe(false);
    expect(result.reason).toBe("ALREADY_HAS_REQUESTED_DELIVERY_DATE");
  });

  it("H. cancelled -> no request, even with every other input perfect", () => {
    const result = decide(
      deliveryOrder({ isCancelled: true, fullyPaid: true, customerClassification: classification("PREPAID", "CONSUMER") }),
    );
    expect(result.shouldRequest).toBe(false);
    expect(result.reason).toBe("ORDER_CANCELLED");
  });

  it("I. BUSINESS + PREPAID -> payment handling follows PREPAID, not customer_type", () => {
    const unpaid = decide(deliveryOrder({ fullyPaid: false, customerClassification: classification("PREPAID", "BUSINESS") }));
    const paid = decide(deliveryOrder({ fullyPaid: true, customerClassification: classification("PREPAID", "BUSINESS") }));
    expect(unpaid.reason).toBe("WAITING_FOR_PAYMENT");
    expect(paid.reason).toBe("READY_FOR_DELIVERY_REQUEST");
  });

  it("J. BUSINESS + ON_ACCOUNT -> payment handling follows ON_ACCOUNT", () => {
    const unpaid = decide(deliveryOrder({ fullyPaid: false, customerClassification: classification("ON_ACCOUNT", "BUSINESS") }));
    expect(unpaid.reason).toBe("READY_FOR_DELIVERY_REQUEST");
    expect(unpaid.reason).not.toBe("WAITING_FOR_PAYMENT");
  });
});

// Phase 6AD build instruction §16 I/J — the ordinary production customer,
// who has no metafields at all, must now be able to reach READY.
describe("evaluateDeliveryRequestDecision — the defaulted ordinary customer", () => {
  function decideWithDefaults(order: OrderForHandoffResult) {
    return evaluateDeliveryRequestDecision({
      order,
      trigger: "ORDER_PAID",
      policy: deliveryPolicyForPaymentPolicy(order.customerClassification.paymentPolicy),
    });
  }

  it("I. absent metafields (-> default PREPAID) + DELIVERY + paid + no date -> READY candidate", () => {
    const order = deliveryOrder({ fullyPaid: true, customerClassification: defaultedClassification() });
    expect(order.customerClassification.paymentPolicySource).toBe("DEFAULT");
    expect(decideWithDefaults(order)).toEqual({
      shouldRequest: true,
      reason: "READY_FOR_DELIVERY_REQUEST",
      trigger: "ORDER_PAID",
    });
  });

  it("J. absent metafields (-> default PREPAID) + DELIVERY + unpaid -> WAITING_FOR_PAYMENT", () => {
    const order = deliveryOrder({ fullyPaid: false, customerClassification: defaultedClassification() });
    expect(decideWithDefaults(order).reason).toBe("WAITING_FOR_PAYMENT");
  });

  it("a defaulted customer behaves identically to one explicitly marked 'betaling vooraf'", () => {
    const defaulted = deliveryOrder({ fullyPaid: true, customerClassification: defaultedClassification() });
    const explicit = deliveryOrder({ fullyPaid: true, customerClassification: classification("PREPAID", "CONSUMER") });
    expect(decideWithDefaults(defaulted)).toEqual(decideWithDefaults(explicit));
  });

  it("but a FAILED read still cannot reach READY — the default is for absence, never for ignorance", () => {
    for (const source of ["UNREADABLE", "NO_CUSTOMER"] as const) {
      const order = deliveryOrder({ fullyPaid: true, customerClassification: unclassifiedCustomer(source) });
      const result = decideWithDefaults(order);
      expect(result.shouldRequest).toBe(false);
      expect(result.reason).toBe("INSUFFICIENT_CLASSIFICATION");
    }
  });

  it("an INVALID stored value still cannot reach READY either", () => {
    const order = deliveryOrder({ fullyPaid: true, customerClassification: classification("UNKNOWN", "CONSUMER") });
    expect(decideWithDefaults(order).reason).toBe("INSUFFICIENT_CLASSIFICATION");
  });

  it("a BUSINESS customer with no payment policy still follows the PREPAID default, not ON_ACCOUNT", () => {
    const businessDefaulted = {
      ...defaultedClassification(),
      customerType: "BUSINESS" as const,
      customerTypeStatus: "VALID" as ClassificationReadState,
      customerTypeSource: "EXPLICIT" as ClassificationValueSource,
    };
    const unpaid = deliveryOrder({ fullyPaid: false, customerClassification: businessDefaulted });
    const paid = deliveryOrder({ fullyPaid: true, customerClassification: businessDefaulted });
    expect(decideWithDefaults(unpaid).reason).toBe("WAITING_FOR_PAYMENT");
    expect(decideWithDefaults(paid).reason).toBe("READY_FOR_DELIVERY_REQUEST");
  });
});

describe("evaluateDeliveryRequestDecision — what a positive decision actually requires", () => {
  it("READY is reachable ONLY with a date-eligible resolution plus a known payment policy that is satisfied", () => {
    // Every single-factor degradation of the one passing case must fail.
    const passing = deliveryOrder({ fullyPaid: true, customerClassification: classification("PREPAID", "CONSUMER") });
    const policy = deliveryPolicyForPaymentPolicy(passing.customerClassification.paymentPolicy);
    expect(evaluateDeliveryRequestDecision({ order: passing, trigger: "ORDER_PAID", policy }).shouldRequest).toBe(true);

    const degradations: OrderForHandoffResult[] = [
      { ...passing, isCancelled: true },
      { ...passing, hasShippingAddress: false },
      { ...passing, hasRequestedDeliveryDateAlready: true, requestedDeliveryDate: "2026-09-24" },
      { ...passing, fulfillmentResolution: { mode: "UNKNOWN", source: "NONE", conflict: false, diagnostic: "NONE" } },
      { ...passing, fulfillmentResolution: { mode: "NONE", source: "EXPLICIT", conflict: false, diagnostic: "NONE" } },
      { ...passing, fullyPaid: false },
    ];
    for (const order of degradations) {
      expect(evaluateDeliveryRequestDecision({ order, trigger: "ORDER_PAID", policy }).shouldRequest).toBe(false);
    }

    // ...and losing the payment classification alone also blocks it.
    expect(
      evaluateDeliveryRequestDecision({ order: passing, trigger: "ORDER_PAID", policy: "UNKNOWN" }).shouldRequest,
    ).toBe(false);
  });

  it("an Order with no customer can never be READY — its classification is UNKNOWN by construction", () => {
    const noCustomer = deliveryOrder({
      fullyPaid: true,
      customerGid: null,
      customerClassification: unclassifiedCustomer("NO_CUSTOMER"),
    });
    const result = evaluateDeliveryRequestDecision({
      order: noCustomer,
      trigger: "ORDER_PAID",
      policy: deliveryPolicyForPaymentPolicy(noCustomer.customerClassification.paymentPolicy),
    });
    expect(result.shouldRequest).toBe(false);
    expect(result.reason).toBe("INSUFFICIENT_CLASSIFICATION");
  });

  it("an unreadable classification fails closed exactly like an absent one", () => {
    const unreadable = deliveryOrder({
      fullyPaid: true,
      customerGid: "gid://shopify/Customer/1",
      customerClassification: unclassifiedCustomer("UNREADABLE"),
    });
    const result = evaluateDeliveryRequestDecision({
      order: unreadable,
      trigger: "ORDER_PAID",
      policy: deliveryPolicyForPaymentPolicy(unreadable.customerClassification.paymentPolicy),
    });
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
    const order = deliveryOrder({ fullyPaid: true, customerClassification: classification("PREPAID") });
    const snapshot = JSON.stringify(order);
    evaluateDeliveryRequestDecision({ order, trigger: "ORDER_PAID", policy: "REGULAR_CONSUMER" });
    expect(JSON.stringify(order)).toBe(snapshot);
  });
});
