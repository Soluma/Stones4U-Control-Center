import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db/prisma";
import type { OrderForHandoffResult } from "@/integrations/shopify/order-for-handoff";
import {
  addDeliveryBusinessDays,
  toDeliveryZoneCivilDate,
} from "@/modules/delivery/delivery-lead-time";

// Phase 6AJ — the Order Status extension's backend, tested at the service
// level. Mocks the two Shopify network boundaries (canonical Order read,
// Order write) and uses the real test database, matching this repo's
// convention.
//
// The point of this file is the AUTHORIZATION boundary: a verified customer
// identity may only ever touch their own Order, and the rules that decide
// what may be written are the 6AI ones, not a second copy.

const mockGetOrderForHandoff = vi.fn();
vi.mock("@/integrations/shopify/order-for-handoff", () => ({
  getOrderForHandoff: (...args: unknown[]) => mockGetOrderForHandoff(...args),
}));

const mockMirrorOrder = vi.fn();
vi.mock("@/integrations/shopify/order-mirror", () => ({
  mirrorRequestedDeliveryDateToOrder: (...args: unknown[]) => mockMirrorOrder(...args),
}));

const mockMirrorMetafields = vi.fn();
vi.mock("@/integrations/shopify/order-logistics-metafields", () => ({
  mirrorOrderLogisticsMetafields: (...args: unknown[]) => mockMirrorMetafields(...args),
}));

const ORDER_A = "gid://shopify/Order/5001";
const ORDER_B = "gid://shopify/Order/5002";
const CUSTOMER_A = "gid://shopify/Customer/7001";
const CUSTOMER_B = "gid://shopify/Customer/7002";

/** A date that always satisfies the two-complete-business-days policy. */
function validDate(): string {
  return addDeliveryBusinessDays(toDeliveryZoneCivilDate(new Date()), 6);
}

function deliveryOrder(overrides: Partial<OrderForHandoffResult> = {}): OrderForHandoffResult {
  return {
    gid: ORDER_A,
    name: "#5001",
    isCancelled: false,
    fulfillmentStatus: "UNFULFILLED",
    customerGid: CUSTOMER_A,
    hasShippingAddress: true,
    hasRequestedDeliveryDateAlready: false,
    requestedDeliveryDate: null,
    fullyPaid: true,
    nativeFulfillmentMode: "DELIVERY",
    explicitFulfillmentMode: "DELIVERY",
    fulfillmentResolution: {
      mode: "DELIVERY",
      source: "EXPLICIT",
      conflict: false,
      diagnostic: "EXPLICIT_CONFIRMED_BY_NATIVE",
    },
    customerClassification: {
      paymentPolicy: "PREPAID",
      customerType: "CONSUMER",
      source: "CUSTOMER_METAFIELDS",
      paymentPolicyStatus: "VALID",
      customerTypeStatus: "VALID",
      paymentPolicySource: "EXPLICIT",
      customerTypeSource: "EXPLICIT",
    },
    ...overrides,
  } as OrderForHandoffResult;
}

/** A pickup Order as the OfferteApp flow actually produces one: the customer's
 * address still rides along on the Order even though nothing is shipped to it.
 * That matters — the 6C eligibility engine rejects an Order with NO shipping
 * address before it ever looks at the fulfillment mode, so an address-less
 * pickup is ineligible today regardless of 6AH. Reusing that engine unchanged
 * is deliberate (build instruction §4); see the report's note on it. */
function pickupOrder(overrides: Partial<OrderForHandoffResult> = {}): OrderForHandoffResult {
  return deliveryOrder({
    nativeFulfillmentMode: "NONE",
    explicitFulfillmentMode: "CUSTOMER_PICKUP",
    hasShippingAddress: true,
    fulfillmentResolution: {
      mode: "CUSTOMER_PICKUP",
      source: "EXPLICIT",
      conflict: false,
      diagnostic: "EXPLICIT_OVERRODE_NATIVE",
    },
    ...overrides,
  });
}

async function service() {
  return import("@/modules/delivery/order-status-extension.service");
}

async function cleanupHandoffs() {
  await prisma.activity.deleteMany({ where: { relatedDeliveryDateHandoff: { externalId: { in: [ORDER_A, ORDER_B] } } } });
  await prisma.deliveryDateHandoff.deleteMany({ where: { externalId: { in: [ORDER_A, ORDER_B] } } });
}

beforeEach(async () => {
  mockGetOrderForHandoff.mockReset();
  mockMirrorOrder.mockReset();
  mockMirrorMetafields.mockReset();
  mockMirrorOrder.mockResolvedValue({ ok: true });
  mockMirrorMetafields.mockResolvedValue({ ok: true });
  await cleanupHandoffs();
});

afterAll(async () => {
  await cleanupHandoffs();
  await prisma.$disconnect();
});

describe("Order/customer binding — the authorization boundary", () => {
  it("lets a customer read their own eligible Order", async () => {
    mockGetOrderForHandoff.mockResolvedValue(deliveryOrder());
    const { readOrderStatusFulfillmentState } = await service();

    const state = await readOrderStatusFulfillmentState({ orderGid: ORDER_A, customerGid: CUSTOMER_A });
    expect(state.status).toBe("CAN_SUBMIT");
    if (state.status !== "CAN_SUBMIT") return;
    expect(state.mode).toBe("DELIVERY");
  });

  it("customer B cannot read customer A's Order", async () => {
    mockGetOrderForHandoff.mockResolvedValue(deliveryOrder());
    const { readOrderStatusFulfillmentState } = await service();

    const state = await readOrderStatusFulfillmentState({ orderGid: ORDER_A, customerGid: CUSTOMER_B });
    expect(state).toEqual({ status: "UNAVAILABLE", reason: "NOT_YOUR_ORDER" });
  });

  it("customer B cannot WRITE to customer A's Order, and nothing is persisted", async () => {
    mockGetOrderForHandoff.mockResolvedValue(deliveryOrder());
    const { submitOrderStatusFulfillmentDate } = await service();

    const result = await submitOrderStatusFulfillmentDate({
      orderGid: ORDER_A,
      customerGid: CUSTOMER_B,
      requestedDeliveryDate: validDate(),
    });

    expect(result).toEqual({ ok: false, kind: "UNAVAILABLE", reason: "NOT_YOUR_ORDER" });
    expect(mockMirrorOrder).not.toHaveBeenCalled();
    expect(await prisma.deliveryDateHandoff.count({ where: { externalId: ORDER_A } })).toBe(0);
  });

  it("a guest Order can never be bound, even by a validly signed customer", async () => {
    mockGetOrderForHandoff.mockResolvedValue(deliveryOrder({ customerGid: null }));
    const { readOrderStatusFulfillmentState, submitOrderStatusFulfillmentDate } = await service();

    expect(await readOrderStatusFulfillmentState({ orderGid: ORDER_A, customerGid: CUSTOMER_A })).toEqual({
      status: "UNAVAILABLE",
      reason: "ORDER_HAS_NO_CUSTOMER",
    });
    const result = await submitOrderStatusFulfillmentDate({
      orderGid: ORDER_A,
      customerGid: CUSTOMER_A,
      requestedDeliveryDate: validDate(),
    });
    expect(result).toEqual({ ok: false, kind: "UNAVAILABLE", reason: "ORDER_HAS_NO_CUSTOMER" });
    expect(mockMirrorOrder).not.toHaveBeenCalled();
  });

  it("an unreadable Order yields a neutral unavailable state, never a throw", async () => {
    mockGetOrderForHandoff.mockResolvedValue(null);
    const { readOrderStatusFulfillmentState } = await service();
    expect(await readOrderStatusFulfillmentState({ orderGid: ORDER_A, customerGid: CUSTOMER_A })).toEqual({
      status: "UNAVAILABLE",
      reason: "ORDER_NOT_READABLE",
    });
  });

  it("a Shopify read failure yields a neutral unavailable state, never a throw", async () => {
    mockGetOrderForHandoff.mockRejectedValue(new Error("network"));
    const { readOrderStatusFulfillmentState } = await service();
    expect(await readOrderStatusFulfillmentState({ orderGid: ORDER_A, customerGid: CUSTOMER_A })).toEqual({
      status: "UNAVAILABLE",
      reason: "ORDER_NOT_READABLE",
    });
  });
});

describe("eligibility is the 6AI decision engine, re-asserted at write time", () => {
  it("rejects an unpaid PREPAID Order", async () => {
    mockGetOrderForHandoff.mockResolvedValue(deliveryOrder({ fullyPaid: false }));
    const { readOrderStatusFulfillmentState, submitOrderStatusFulfillmentDate } = await service();

    expect((await readOrderStatusFulfillmentState({ orderGid: ORDER_A, customerGid: CUSTOMER_A })).status)
      .toBe("UNAVAILABLE");
    const result = await submitOrderStatusFulfillmentDate({
      orderGid: ORDER_A,
      customerGid: CUSTOMER_A,
      requestedDeliveryDate: validDate(),
    });
    expect(result).toEqual({ ok: false, kind: "UNAVAILABLE", reason: "NOT_ELIGIBLE" });
    expect(mockMirrorOrder).not.toHaveBeenCalled();
  });

  it("rejects a cancelled Order", async () => {
    mockGetOrderForHandoff.mockResolvedValue(deliveryOrder({ isCancelled: true }));
    const { submitOrderStatusFulfillmentDate } = await service();
    const result = await submitOrderStatusFulfillmentDate({
      orderGid: ORDER_A,
      customerGid: CUSTOMER_A,
      requestedDeliveryDate: validDate(),
    });
    expect(result).toEqual({ ok: false, kind: "UNAVAILABLE", reason: "NOT_ELIGIBLE" });
    expect(mockMirrorOrder).not.toHaveBeenCalled();
  });

  it("rejects modes that need no date — NONE, RETAIL, PICKUP_POINT", async () => {
    const { submitOrderStatusFulfillmentDate } = await service();
    for (const mode of ["NONE", "RETAIL", "PICKUP_POINT"] as const) {
      mockGetOrderForHandoff.mockResolvedValue(
        deliveryOrder({
          explicitFulfillmentMode: mode,
          fulfillmentResolution: { mode, source: "EXPLICIT", conflict: false, diagnostic: "EXPLICIT_OVERRODE_NATIVE" },
        }),
      );
      const result = await submitOrderStatusFulfillmentDate({
        orderGid: ORDER_A,
        customerGid: CUSTOMER_A,
        requestedDeliveryDate: validDate(),
      });
      expect(result).toEqual({ ok: false, kind: "UNAVAILABLE", reason: "NOT_ELIGIBLE" });
    }
    expect(mockMirrorOrder).not.toHaveBeenCalled();
  });

  it("rejects an UNKNOWN (unclassified) fulfillment mode", async () => {
    mockGetOrderForHandoff.mockResolvedValue(
      deliveryOrder({
        explicitFulfillmentMode: null,
        fulfillmentResolution: { mode: "UNKNOWN", source: "NONE", conflict: false, diagnostic: "NATIVE_NOT_TRUSTED" },
      }),
    );
    const { submitOrderStatusFulfillmentDate } = await service();
    const result = await submitOrderStatusFulfillmentDate({
      orderGid: ORDER_A,
      customerGid: CUSTOMER_A,
      requestedDeliveryDate: validDate(),
    });
    expect(result).toEqual({ ok: false, kind: "UNAVAILABLE", reason: "NOT_ELIGIBLE" });
  });

  it("shows an existing date instead of asking again, and refuses to overwrite it", async () => {
    const existing = validDate();
    mockGetOrderForHandoff.mockResolvedValue(
      deliveryOrder({ hasRequestedDeliveryDateAlready: true, requestedDeliveryDate: existing }),
    );
    const { readOrderStatusFulfillmentState, submitOrderStatusFulfillmentDate } = await service();

    const state = await readOrderStatusFulfillmentState({ orderGid: ORDER_A, customerGid: CUSTOMER_A });
    expect(state.status).toBe("ALREADY_SUBMITTED");
    if (state.status !== "ALREADY_SUBMITTED") return;
    expect(state.requestedDeliveryDate).toBe(existing);

    const result = await submitOrderStatusFulfillmentDate({
      orderGid: ORDER_A,
      customerGid: CUSTOMER_A,
      requestedDeliveryDate: addDeliveryBusinessDays(existing, 2),
    });
    expect(result).toEqual({ ok: false, kind: "UNAVAILABLE", reason: "NOT_ELIGIBLE" });
    expect(mockMirrorOrder).not.toHaveBeenCalled();
  });
});

describe("the date policy is the server's, not the browser's", () => {
  it("rejects a weekend date", async () => {
    mockGetOrderForHandoff.mockResolvedValue(deliveryOrder());
    const { submitOrderStatusFulfillmentDate } = await service();

    // Walk forward to the next Saturday from an otherwise-valid date.
    let candidate = validDate();
    for (let i = 0; i < 7; i++) {
      const d = new Date(`${candidate}T12:00:00Z`);
      if (d.getUTCDay() === 6) break;
      d.setUTCDate(d.getUTCDate() + 1);
      candidate = d.toISOString().slice(0, 10);
    }

    const result = await submitOrderStatusFulfillmentDate({
      orderGid: ORDER_A,
      customerGid: CUSTOMER_A,
      requestedDeliveryDate: candidate,
    });
    expect(result).toMatchObject({ ok: false, kind: "INVALID" });
    expect(mockMirrorOrder).not.toHaveBeenCalled();
  });

  it("rejects a too-early date", async () => {
    mockGetOrderForHandoff.mockResolvedValue(deliveryOrder());
    const { submitOrderStatusFulfillmentDate } = await service();

    const result = await submitOrderStatusFulfillmentDate({
      orderGid: ORDER_A,
      customerGid: CUSTOMER_A,
      requestedDeliveryDate: toDeliveryZoneCivilDate(new Date()),
    });
    expect(result).toMatchObject({ ok: false, kind: "INVALID" });
    expect(mockMirrorOrder).not.toHaveBeenCalled();
  });

  it("rejects a missing date", async () => {
    mockGetOrderForHandoff.mockResolvedValue(deliveryOrder());
    const { submitOrderStatusFulfillmentDate } = await service();
    const result = await submitOrderStatusFulfillmentDate({
      orderGid: ORDER_A,
      customerGid: CUSTOMER_A,
      requestedDeliveryDate: undefined,
    });
    expect(result).toMatchObject({ ok: false, kind: "INVALID" });
  });
});

describe("a successful submission goes down the 6AI path", () => {
  it("writes the date, the comment and the truck flag for DELIVERY", async () => {
    mockGetOrderForHandoff.mockResolvedValue(deliveryOrder());
    const { submitOrderStatusFulfillmentDate } = await service();
    const date = validDate();

    const result = await submitOrderStatusFulfillmentDate({
      orderGid: ORDER_A,
      customerGid: CUSTOMER_A,
      requestedDeliveryDate: date,
      deliveryComment: "Achterom, blauwe poort",
      largeTruckAccessConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true, mode: "DELIVERY", requestedDeliveryDate: date });
    expect(mockMirrorOrder).toHaveBeenCalled();

    const handoff = await prisma.deliveryDateHandoff.findFirst({ where: { externalId: ORDER_A } });
    expect(handoff).toBeTruthy();
    expect(handoff!.deliveryComment).toBe("Achterom, blauwe poort");
    expect(handoff!.largeTruckAccessConfirmed).toBe(true);
    // The customer answered directly — there is no staff creator.
    expect(handoff!.createdById).toBeNull();
  });

  it("a pickup submission never records a truck answer, even if one is sent", async () => {
    mockGetOrderForHandoff.mockResolvedValue(pickupOrder());
    const { submitOrderStatusFulfillmentDate } = await service();

    const result = await submitOrderStatusFulfillmentDate({
      orderGid: ORDER_A,
      customerGid: CUSTOMER_A,
      requestedDeliveryDate: validDate(),
      deliveryComment: "Ik kom met een aanhanger",
      // A crafted request: the pickup UI never asks this.
      largeTruckAccessConfirmed: true,
    });

    expect(result).toMatchObject({ ok: true, mode: "CUSTOMER_PICKUP" });
    const handoff = await prisma.deliveryDateHandoff.findFirst({ where: { externalId: ORDER_A } });
    expect(handoff!.largeTruckAccessConfirmed).toBeNull();
    expect(handoff!.deliveryComment).toBe("Ik kom met een aanhanger");
  });

  it("records an audit entry and reuses one handoff row per Order", async () => {
    mockGetOrderForHandoff.mockResolvedValue(deliveryOrder());
    const { submitOrderStatusFulfillmentDate } = await service();

    await submitOrderStatusFulfillmentDate({
      orderGid: ORDER_A,
      customerGid: CUSTOMER_A,
      requestedDeliveryDate: validDate(),
    });
    expect(await prisma.deliveryDateHandoff.count({ where: { externalId: ORDER_A } })).toBe(1);

    const handoff = await prisma.deliveryDateHandoff.findFirst({ where: { externalId: ORDER_A } });
    const audits = await prisma.auditEvent.findMany({
      where: { entityType: "DeliveryDateHandoff", entityId: handoff!.id },
    });
    expect(audits.some((a) => a.action === "delivery_handoff.date_requested")).toBe(true);
    // The customer's free text is never copied into audit metadata.
    expect(JSON.stringify(audits)).not.toContain("Achterom");
  });
});
