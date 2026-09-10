import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { createTestUser, cleanupUser } from "./fixtures";
import { OrderCancelledError } from "@/integrations/shopify/errors";
import { FulfillmentModeConfirmationRequiredError } from "@/modules/delivery/errors";

// Phase 6L — service-level tests. Mocks only the two Shopify network
// boundaries (the canonical read and the contract write) and uses the real
// test database for audit, matching this repo's established convention.

const mockGetOrderForHandoff = vi.fn();
vi.mock("@/integrations/shopify/order-for-handoff", () => ({
  getOrderForHandoff: (...args: unknown[]) => mockGetOrderForHandoff(...args),
}));

const mockWriteOrderFulfillmentMode = vi.fn();
vi.mock("@/integrations/shopify/order-fulfillment-mode-mirror", () => ({
  writeOrderFulfillmentMode: (...args: unknown[]) => mockWriteOrderFulfillmentMode(...args),
}));

const ORDER_GID = "gid://shopify/Order/9001";

function orderRead(overrides: Record<string, unknown> = {}) {
  return {
    gid: ORDER_GID,
    name: "#9001",
    isCancelled: false,
    fulfillmentStatus: "UNFULFILLED",
    customerGid: null,
    hasShippingAddress: true,
    hasRequestedDeliveryDateAlready: false,
    requestedDeliveryDate: null,
    fullyPaid: true,
    nativeFulfillmentMode: "DELIVERY",
    explicitFulfillmentMode: null,
    fulfillmentResolution: { mode: "UNKNOWN", source: "NONE", conflict: false, diagnostic: "NATIVE_NOT_TRUSTED" },
    ...overrides,
  };
}

function writeResult(overrides: Record<string, unknown> = {}) {
  return {
    orderGid: ORDER_GID,
    orderName: "#9001",
    written: true,
    previous: { status: "ABSENT" },
    duplicatesRemoved: 0,
    ...overrides,
  };
}

describe("staff fulfillment mode service", () => {
  let actorId: string;

  beforeAll(async () => {
    const admin = await createTestUser({ role: "ADMIN" });
    actorId = admin.id;
  });

  beforeEach(async () => {
    mockGetOrderForHandoff.mockReset();
    mockWriteOrderFulfillmentMode.mockReset();
    await prisma.auditEvent.deleteMany({ where: { userId: actorId } });
  });

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { userId: actorId } });
    await cleanupUser(actorId);
    await prisma.$disconnect();
  });

  async function auditEvents() {
    return prisma.auditEvent.findMany({ where: { userId: actorId }, orderBy: { createdAt: "asc" } });
  }

  it("sets a first explicit mode without requiring confirmation, and audits it once", async () => {
    mockGetOrderForHandoff
      .mockResolvedValueOnce(orderRead())
      .mockResolvedValueOnce(
        orderRead({
          explicitFulfillmentMode: "CUSTOMER_PICKUP",
          fulfillmentResolution: { mode: "CUSTOMER_PICKUP", source: "EXPLICIT", conflict: false, diagnostic: "EXPLICIT_OVERRODE_NATIVE" },
        }),
      );
    mockWriteOrderFulfillmentMode.mockResolvedValueOnce(writeResult());

    const { setOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");
    const result = await setOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId, mode: "CUSTOMER_PICKUP" });

    expect(result.changed).toBe(true);
    expect(result.repaired).toBe(false);
    expect(result.classification.resolution.mode).toBe("CUSTOMER_PICKUP");
    expect(mockWriteOrderFulfillmentMode).toHaveBeenCalledWith(ORDER_GID, "CUSTOMER_PICKUP");

    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("order_fulfillment_mode.set");
    expect(events[0]!.entityType).toBe("ShopifyOrder");
    expect(events[0]!.entityId).toBe(ORDER_GID);
    expect(events[0]!.metadata).toMatchObject({ previousState: "ABSENT", newMode: "CUSTOMER_PICKUP" });
  });

  it("accepts every canonical mode", async () => {
    const { setOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");
    for (const mode of ["DELIVERY", "CUSTOMER_PICKUP", "PICKUP_POINT", "RETAIL", "NONE"] as const) {
      mockGetOrderForHandoff.mockResolvedValueOnce(orderRead()).mockResolvedValueOnce(orderRead({ explicitFulfillmentMode: mode }));
      mockWriteOrderFulfillmentMode.mockResolvedValueOnce(writeResult());
      await expect(setOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId, mode })).resolves.toBeTruthy();
    }
  });

  it("requires confirmation before changing an existing choice, and writes nothing until confirmed", async () => {
    mockGetOrderForHandoff.mockResolvedValueOnce(
      orderRead({
        explicitFulfillmentMode: "CUSTOMER_PICKUP",
        fulfillmentResolution: { mode: "CUSTOMER_PICKUP", source: "EXPLICIT", conflict: false, diagnostic: "EXPLICIT_OVERRODE_NATIVE" },
      }),
    );

    const { setOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");
    const error = await setOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId, mode: "DELIVERY" }).catch((e) => e);

    expect(error).toBeInstanceOf(FulfillmentModeConfirmationRequiredError);
    expect(error.currentMode).toBe("CUSTOMER_PICKUP");
    expect(error.currentState).toBe("VALID");
    expect(error.requestedMode).toBe("DELIVERY");
    expect(mockWriteOrderFulfillmentMode).not.toHaveBeenCalled();
    expect(await auditEvents()).toHaveLength(0);
  });

  it("performs the change once confirmed, auditing the previous and new value", async () => {
    mockGetOrderForHandoff
      .mockResolvedValueOnce(orderRead({ explicitFulfillmentMode: "CUSTOMER_PICKUP" }))
      .mockResolvedValueOnce(
        orderRead({
          explicitFulfillmentMode: "DELIVERY",
          fulfillmentResolution: { mode: "DELIVERY", source: "EXPLICIT", conflict: false, diagnostic: "NONE" },
        }),
      );
    mockWriteOrderFulfillmentMode.mockResolvedValueOnce(writeResult({ previous: { status: "VALID", mode: "CUSTOMER_PICKUP" } }));

    const { setOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");
    const result = await setOrderFulfillmentModeForStaff({
      orderGid: ORDER_GID,
      actorId,
      mode: "DELIVERY",
      confirmChange: true,
      expectedCurrentState: "VALID:CUSTOMER_PICKUP",
    });

    expect(result.changed).toBe(true);
    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({ previousMode: "CUSTOMER_PICKUP", newMode: "DELIVERY" });
  });

  it("is idempotent: re-selecting the same mode needs no confirmation, writes nothing and audits nothing", async () => {
    mockGetOrderForHandoff
      .mockResolvedValueOnce(orderRead({ explicitFulfillmentMode: "CUSTOMER_PICKUP" }))
      .mockResolvedValueOnce(orderRead({ explicitFulfillmentMode: "CUSTOMER_PICKUP" }));
    mockWriteOrderFulfillmentMode.mockResolvedValueOnce(writeResult({ written: false }));

    const { setOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");
    const result = await setOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId, mode: "CUSTOMER_PICKUP" });

    expect(result.changed).toBe(false);
    expect(await auditEvents()).toHaveLength(0);
  });

  it("clearing when nothing is set succeeds without confirmation, write or audit", async () => {
    mockGetOrderForHandoff.mockResolvedValueOnce(orderRead()).mockResolvedValueOnce(orderRead());
    mockWriteOrderFulfillmentMode.mockResolvedValueOnce(writeResult({ written: false }));

    const { clearOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");
    const result = await clearOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId });

    expect(result.changed).toBe(false);
    expect(await auditEvents()).toHaveLength(0);
  });

  it("clearing an existing choice requires confirmation, then restores native fallback resolution", async () => {
    mockGetOrderForHandoff.mockResolvedValueOnce(orderRead({ explicitFulfillmentMode: "CUSTOMER_PICKUP" }));
    const { clearOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");
    await expect(clearOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId })).rejects.toBeInstanceOf(
      FulfillmentModeConfirmationRequiredError,
    );
    expect(mockWriteOrderFulfillmentMode).not.toHaveBeenCalled();

    mockGetOrderForHandoff
      .mockResolvedValueOnce(orderRead({ explicitFulfillmentMode: "CUSTOMER_PICKUP" }))
      .mockResolvedValueOnce(orderRead());
    mockWriteOrderFulfillmentMode.mockResolvedValueOnce(writeResult({ previous: { status: "VALID", mode: "CUSTOMER_PICKUP" } }));

    const result = await clearOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId, confirmChange: true, expectedCurrentState: "VALID:CUSTOMER_PICKUP" });
    expect(result.changed).toBe(true);
    // Native DELIVERY alone is not trusted, so the Order falls back to UNKNOWN.
    expect(result.classification.resolution.mode).toBe("UNKNOWN");
    expect(mockWriteOrderFulfillmentMode).toHaveBeenCalledWith(ORDER_GID, null);

    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("order_fulfillment_mode.cleared");
    expect(events[0]!.metadata).toMatchObject({ newMode: null });
  });

  it("a duplicated existing key requires confirmation and is audited as a repair, not an ordinary set", async () => {
    const duplicated = orderRead({
      explicitFulfillmentMode: null,
      fulfillmentResolution: { mode: "UNKNOWN", source: "NONE", conflict: true, diagnostic: "DUPLICATE_EXPLICIT_KEY" },
    });
    mockGetOrderForHandoff.mockResolvedValueOnce(duplicated);

    const { setOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");
    const error = await setOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId, mode: "CUSTOMER_PICKUP" }).catch((e) => e);
    expect(error).toBeInstanceOf(FulfillmentModeConfirmationRequiredError);
    expect(error.currentState).toBe("DUPLICATE");
    expect(mockWriteOrderFulfillmentMode).not.toHaveBeenCalled();

    mockGetOrderForHandoff
      .mockResolvedValueOnce(duplicated)
      .mockResolvedValueOnce(orderRead({ explicitFulfillmentMode: "CUSTOMER_PICKUP" }));
    mockWriteOrderFulfillmentMode.mockResolvedValueOnce(writeResult({ previous: { status: "DUPLICATE" }, duplicatesRemoved: 1 }));

    const result = await setOrderFulfillmentModeForStaff({
      orderGid: ORDER_GID,
      actorId,
      mode: "CUSTOMER_PICKUP",
      confirmChange: true,
      expectedCurrentState: "DUPLICATE",
    });
    expect(result.repaired).toBe(true);

    const events = await auditEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("order_fulfillment_mode.repaired");
    expect(events[0]!.metadata).toMatchObject({ previousState: "DUPLICATE", duplicatesRemoved: 1 });
  });

  it("an invalid existing value is also a confirmed repair", async () => {
    const invalid = orderRead({
      fulfillmentResolution: { mode: "UNKNOWN", source: "NONE", conflict: true, diagnostic: "INVALID_EXPLICIT_VALUE" },
    });
    mockGetOrderForHandoff.mockResolvedValueOnce(invalid).mockResolvedValueOnce(orderRead({ explicitFulfillmentMode: "RETAIL" }));
    mockWriteOrderFulfillmentMode.mockResolvedValueOnce(writeResult({ previous: { status: "INVALID" } }));

    const { setOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");
    const result = await setOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId, mode: "RETAIL", confirmChange: true, expectedCurrentState: "INVALID" });

    expect(result.repaired).toBe(true);
    expect((await auditEvents())[0]!.action).toBe("order_fulfillment_mode.repaired");
  });

  it("refuses a cancelled Order before any write, and audits nothing", async () => {
    mockGetOrderForHandoff.mockResolvedValueOnce(orderRead({ isCancelled: true }));

    const { setOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");
    await expect(
      setOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId, mode: "DELIVERY", confirmChange: true }),
    ).rejects.toBeInstanceOf(OrderCancelledError);

    expect(mockWriteOrderFulfillmentMode).not.toHaveBeenCalled();
    expect(await auditEvents()).toHaveLength(0);
  });

  it("never creates a customer Activity for a classification change", async () => {
    mockGetOrderForHandoff.mockResolvedValueOnce(orderRead()).mockResolvedValueOnce(orderRead({ explicitFulfillmentMode: "DELIVERY" }));
    mockWriteOrderFulfillmentMode.mockResolvedValueOnce(writeResult());

    const activitiesBefore = await prisma.activity.count();
    const { setOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");
    await setOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId, mode: "DELIVERY" });

    expect(await prisma.activity.count()).toBe(activitiesBefore);
  });

  it("a confirmation only authorizes the transition staff were shown — stale state re-prompts instead of writing", async () => {
    const { setOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");

    // Staff are shown CUSTOMER_PICKUP and confirm changing it to DELIVERY…
    mockGetOrderForHandoff.mockResolvedValueOnce(orderRead({ explicitFulfillmentMode: "CUSTOMER_PICKUP" }));
    const first = await setOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId, mode: "DELIVERY" }).catch((e) => e);
    expect(first.currentStateToken).toBe("VALID:CUSTOMER_PICKUP");

    // …but someone else set it to RETAIL before the confirmed retry landed.
    mockGetOrderForHandoff.mockResolvedValueOnce(orderRead({ explicitFulfillmentMode: "RETAIL" }));
    const stale = await setOrderFulfillmentModeForStaff({
      orderGid: ORDER_GID,
      actorId,
      mode: "DELIVERY",
      confirmChange: true,
      expectedCurrentState: first.currentStateToken,
    }).catch((e) => e);

    expect(stale).toBeInstanceOf(FulfillmentModeConfirmationRequiredError);
    // The re-prompt carries the NEW state, not the one staff first saw.
    expect(stale.currentMode).toBe("RETAIL");
    expect(stale.currentStateToken).toBe("VALID:RETAIL");
    expect(mockWriteOrderFulfillmentMode).not.toHaveBeenCalled();
    expect(await auditEvents()).toHaveLength(0);
  });

  it("a confirmation without the state echo is refused rather than allowed through", async () => {
    mockGetOrderForHandoff.mockResolvedValueOnce(orderRead({ explicitFulfillmentMode: "CUSTOMER_PICKUP" }));

    const { setOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");
    await expect(
      setOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId, mode: "DELIVERY", confirmChange: true }),
    ).rejects.toBeInstanceOf(FulfillmentModeConfirmationRequiredError);
    expect(mockWriteOrderFulfillmentMode).not.toHaveBeenCalled();
  });

  it("a failed Shopify write creates no audit entry claiming success", async () => {
    mockGetOrderForHandoff.mockResolvedValueOnce(orderRead());
    mockWriteOrderFulfillmentMode.mockRejectedValueOnce(new Error("Verificatie na schrijven mislukt"));

    const { setOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");
    await expect(setOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId, mode: "DELIVERY" })).rejects.toThrow(
      /Verificatie na schrijven mislukt/,
    );

    expect(await auditEvents()).toHaveLength(0);
  });

  it("a cancellation that lands between the service read and the write is still blocked, with no audit", async () => {
    // The service's own read saw an active Order; the writer's canonical
    // re-read is what catches the cancellation.
    mockGetOrderForHandoff.mockResolvedValueOnce(orderRead());
    mockWriteOrderFulfillmentMode.mockRejectedValueOnce(new OrderCancelledError(ORDER_GID));

    const { setOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");
    await expect(
      setOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId, mode: "DELIVERY" }),
    ).rejects.toBeInstanceOf(OrderCancelledError);

    expect(await auditEvents()).toHaveLength(0);
  });

  it("setting explicit DELIVERY classifies only — no handoff is created and no delivery date is touched", async () => {
    mockGetOrderForHandoff.mockResolvedValueOnce(orderRead({ requestedDeliveryDate: "2026-09-24", hasRequestedDeliveryDateAlready: true })).mockResolvedValueOnce(
      orderRead({
        explicitFulfillmentMode: "DELIVERY",
        requestedDeliveryDate: "2026-09-24",
        hasRequestedDeliveryDateAlready: true,
        fulfillmentResolution: { mode: "DELIVERY", source: "EXPLICIT", conflict: false, diagnostic: "NONE" },
      }),
    );
    mockWriteOrderFulfillmentMode.mockResolvedValueOnce(writeResult());

    const handoffsBefore = await prisma.deliveryDateHandoff.count();
    const { setOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");
    const result = await setOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId, mode: "DELIVERY" });

    expect(result.classification.resolution.mode).toBe("DELIVERY");
    // Classification data only — READY stays unreachable and nothing is sent.
    expect(await prisma.deliveryDateHandoff.count()).toBe(handoffsBefore);
    expect(result.classification.requestedDeliveryDate).toBe("2026-09-24");
  });

  it("never trusts caller-supplied state — only the Order GID and requested mode reach the writer", async () => {
    mockGetOrderForHandoff.mockResolvedValueOnce(orderRead()).mockResolvedValueOnce(orderRead({ explicitFulfillmentMode: "NONE" }));
    mockWriteOrderFulfillmentMode.mockResolvedValueOnce(writeResult());

    const { setOrderFulfillmentModeForStaff } = await import("@/modules/delivery/fulfillment-mode.service");
    await setOrderFulfillmentModeForStaff({ orderGid: ORDER_GID, actorId, mode: "NONE" });

    expect(mockWriteOrderFulfillmentMode).toHaveBeenCalledTimes(1);
    expect(mockWriteOrderFulfillmentMode.mock.calls[0]).toEqual([ORDER_GID, "NONE"]);
    // The state used for the decision came from the server read, not a caller.
    expect(mockGetOrderForHandoff).toHaveBeenCalledWith(ORDER_GID);
  });
});
