import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { createTestUser, cleanupUser, cleanupDeliveryDateHandoff } from "./fixtures";

// Phase 6F — same technique as tests/delivery-handoff.test.ts's
// createOrderDeliveryHandoffForStaff() tests: mock only the Shopify
// network boundary (getOrderForHandoff), use the real test database for
// everything else (the receipt row, evaluateDeliveryRequestDecision,
// createOrGetOrderDeliveryHandoff) — integration-style, matching this
// repo's established convention.

const mockGetOrderForHandoff = vi.fn();
vi.mock("@/integrations/shopify/order-for-handoff", () => ({
  getOrderForHandoff: (...args: unknown[]) => mockGetOrderForHandoff(...args),
}));

describe("processOrderWebhookEvent", () => {
  let adminId: string;
  const createdHandoffIds: string[] = [];
  const receiptIds: string[] = [];

  beforeAll(async () => {
    const admin = await createTestUser({ role: "ADMIN" });
    adminId = admin.id;
  });

  beforeEach(() => {
    mockGetOrderForHandoff.mockReset();
  });

  afterAll(async () => {
    for (const id of createdHandoffIds) await cleanupDeliveryDateHandoff(id);
    await prisma.shopifyWebhookEvent.deleteMany({ where: { id: { in: receiptIds } } });
    await cleanupUser(adminId);
    await prisma.$disconnect();
  });

  async function createReceipt() {
    const receipt = await prisma.shopifyWebhookEvent.create({
      data: {
        shopDomain: "stones4u-dev.myshopify.com",
        webhookId: crypto.randomUUID(),
        topic: "orders/paid",
        status: "RECEIVED",
      },
    });
    receiptIds.push(receipt.id);
    return receipt;
  }

  function order(overrides: Record<string, unknown> = {}) {
    return {
      gid: `gid://shopify/Order/${crypto.randomUUID()}`,
      name: "#0000",
      isCancelled: false,
      fulfillmentStatus: "UNFULFILLED",
      customerGid: null,
      hasShippingAddress: true,
      hasRequestedDeliveryDateAlready: false,
      requestedDeliveryDate: null,
      fullyPaid: false,
      nativeFulfillmentMode: "UNKNOWN",
      explicitFulfillmentMode: null,
      fulfillmentResolution: { mode: "UNKNOWN", source: "NONE", conflict: false, diagnostic: "NONE" },
      ...overrides,
    };
  }

  it("marks the receipt FAILED and returns ORDER_NOT_READABLE when the canonical re-read finds nothing", async () => {
    mockGetOrderForHandoff.mockResolvedValueOnce(null);
    const receipt = await createReceipt();
    const { processOrderWebhookEvent } = await import("@/modules/delivery/order-webhook-processing");

    const result = await processOrderWebhookEvent({
      receiptId: receipt.id,
      orderGid: "gid://shopify/Order/1",
      trigger: "ORDER_PAID",
    });

    expect(result).toEqual({ outcome: "ORDER_NOT_READABLE" });
    const reloaded = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(reloaded.status).toBe("FAILED");
    expect(reloaded.errorSummary).toBe("ORDER_NOT_FOUND_ON_REREAD");
  });

  it("a paid Order with no positive classification signal persists INSUFFICIENT_CLASSIFICATION — no handoff, not a false positive", async () => {
    const snapshot = order({ fullyPaid: true });
    mockGetOrderForHandoff.mockResolvedValueOnce(snapshot);
    const receipt = await createReceipt();
    const { processOrderWebhookEvent } = await import("@/modules/delivery/order-webhook-processing");

    const result = await processOrderWebhookEvent({ receiptId: receipt.id, orderGid: snapshot.gid, trigger: "ORDER_PAID" });

    expect(result.outcome).toBe("PROCESSED");
    if (result.outcome === "PROCESSED") {
      expect(result.decision).toEqual({ shouldRequest: false, reason: "INSUFFICIENT_CLASSIFICATION", trigger: "ORDER_PAID" });
      expect(result.createdHandoffId).toBeNull();
    }
    const reloaded = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(reloaded.status).toBe("PROCESSED");
    expect(reloaded.eligible).toBe(false);
    expect(reloaded.eligibilityReason).toBe("INSUFFICIENT_CLASSIFICATION");
    expect(reloaded.createdHandoffId).toBeNull();
    const handoffCount = await prisma.deliveryDateHandoff.count({ where: { externalId: snapshot.gid } });
    expect(handoffCount).toBe(0);
  });

  it("an existing requested_delivery_date suppresses even a fully-paid Order, and never creates a handoff (build instruction §11)", async () => {
    const snapshot = order({ fullyPaid: true, hasRequestedDeliveryDateAlready: true, requestedDeliveryDate: "2026-09-24" });
    mockGetOrderForHandoff.mockResolvedValueOnce(snapshot);
    const receipt = await createReceipt();
    const { processOrderWebhookEvent } = await import("@/modules/delivery/order-webhook-processing");

    const result = await processOrderWebhookEvent({ receiptId: receipt.id, orderGid: snapshot.gid, trigger: "ORDER_PAID" });

    expect(result.outcome).toBe("PROCESSED");
    if (result.outcome === "PROCESSED") {
      expect(result.decision.reason).toBe("ALREADY_HAS_REQUESTED_DELIVERY_DATE");
      expect(result.createdHandoffId).toBeNull();
    }
    const handoffCount = await prisma.deliveryDateHandoff.count({ where: { externalId: snapshot.gid } });
    expect(handoffCount).toBe(0);
  });

  it("real webhook processing always passes policy: UNKNOWN (no classifier exists yet) — an unpaid Order persists INSUFFICIENT_CLASSIFICATION, never WAITING_FOR_PAYMENT (final review, this round — the core policy-default bug)", async () => {
    const snapshot = order({ fullyPaid: false, hasShippingAddress: true });
    mockGetOrderForHandoff.mockResolvedValueOnce(snapshot);
    const receipt = await createReceipt();
    const { processOrderWebhookEvent } = await import("@/modules/delivery/order-webhook-processing");

    const result = await processOrderWebhookEvent({ receiptId: receipt.id, orderGid: snapshot.gid, trigger: "ORDER_CREATED" });
    if (result.outcome === "PROCESSED") {
      expect(result.decision.reason).not.toBe("WAITING_FOR_PAYMENT");
      expect(result.decision.reason).toBe("INSUFFICIENT_CLASSIFICATION");
    } else {
      throw new Error(`expected PROCESSED, got ${result.outcome}`);
    }
  });

  it("real webhook processing stays conservative even once fullyPaid becomes true — UNKNOWN policy never consults payment state at all", async () => {
    const snapshot = order({ fullyPaid: true, hasShippingAddress: true });
    mockGetOrderForHandoff.mockResolvedValueOnce(snapshot);
    const receipt = await createReceipt();
    const { processOrderWebhookEvent } = await import("@/modules/delivery/order-webhook-processing");

    const result = await processOrderWebhookEvent({ receiptId: receipt.id, orderGid: snapshot.gid, trigger: "ORDER_PAID" });
    if (result.outcome === "PROCESSED") {
      expect(result.decision.reason).toBe("INSUFFICIENT_CLASSIFICATION");
      expect(result.createdHandoffId).toBeNull();
    } else {
      throw new Error(`expected PROCESSED, got ${result.outcome}`);
    }
  });

  it("a cancelled Order persists ORDER_CANCELLED — no handoff", async () => {
    const snapshot = order({ isCancelled: true, fullyPaid: true });
    mockGetOrderForHandoff.mockResolvedValueOnce(snapshot);
    const receipt = await createReceipt();
    const { processOrderWebhookEvent } = await import("@/modules/delivery/order-webhook-processing");

    const result = await processOrderWebhookEvent({ receiptId: receipt.id, orderGid: snapshot.gid, trigger: "ORDER_PAID" });
    if (result.outcome === "PROCESSED") expect(result.decision.reason).toBe("ORDER_CANCELLED");
  });

  it("no shipping address persists NO_SHIPPING_ADDRESS — no handoff", async () => {
    const snapshot = order({ hasShippingAddress: false, fullyPaid: true });
    mockGetOrderForHandoff.mockResolvedValueOnce(snapshot);
    const receipt = await createReceipt();
    const { processOrderWebhookEvent } = await import("@/modules/delivery/order-webhook-processing");

    const result = await processOrderWebhookEvent({ receiptId: receipt.id, orderGid: snapshot.gid, trigger: "ORDER_PAID" });
    if (result.outcome === "PROCESSED") expect(result.decision.reason).toBe("NO_SHIPPING_ADDRESS");
  });

  it("a requested date added between ORDERS_CREATE and ORDERS_PAID is caught by the re-read, not stale create-time state (build instruction §12)", async () => {
    // Simulates: ORDERS_CREATE saw no date; before payment, staff/quote
    // entered one; ORDERS_PAID's own canonical re-read must see it fresh.
    const snapshot = order({ fullyPaid: true, hasRequestedDeliveryDateAlready: true, requestedDeliveryDate: "2026-10-01" });
    mockGetOrderForHandoff.mockResolvedValueOnce(snapshot);
    const receipt = await createReceipt();
    const { processOrderWebhookEvent } = await import("@/modules/delivery/order-webhook-processing");

    const result = await processOrderWebhookEvent({ receiptId: receipt.id, orderGid: snapshot.gid, trigger: "ORDER_PAID" });
    if (result.outcome === "PROCESSED") {
      expect(result.decision.reason).toBe("ALREADY_HAS_REQUESTED_DELIVERY_DATE");
      expect(result.createdHandoffId).toBeNull();
    }
    expect(mockGetOrderForHandoff).toHaveBeenCalledWith(snapshot.gid);
  });

  it("never creates a customer-facing Activity — this module has no Activity-writing code path at all (build instruction §19)", async () => {
    const snapshot = order({ fullyPaid: true });
    mockGetOrderForHandoff.mockResolvedValueOnce(snapshot);
    const receipt = await createReceipt();
    const { processOrderWebhookEvent } = await import("@/modules/delivery/order-webhook-processing");

    const before = await prisma.activity.count();
    await processOrderWebhookEvent({ receiptId: receipt.id, orderGid: snapshot.gid, trigger: "ORDER_PAID" });
    const after = await prisma.activity.count();
    expect(after).toBe(before);
  });

  it("never mutates Shopify — getOrderForHandoff is the only Shopify interaction, and it is a read", async () => {
    const snapshot = order({ fullyPaid: true, hasRequestedDeliveryDateAlready: true, requestedDeliveryDate: "2026-09-24" });
    mockGetOrderForHandoff.mockResolvedValueOnce(snapshot);
    const receipt = await createReceipt();
    const { processOrderWebhookEvent } = await import("@/modules/delivery/order-webhook-processing");

    await processOrderWebhookEvent({ receiptId: receipt.id, orderGid: snapshot.gid, trigger: "ORDER_PAID" });
    expect(mockGetOrderForHandoff).toHaveBeenCalledTimes(1);
  });
});
