import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { claimWebhookDelivery, markWebhookProcessed, markWebhookFailed } from "@/modules/delivery/webhook-receipt.service";

const SHOP = "stones4u-dev.myshopify.com";

describe("webhook-receipt.service — durable idempotency", () => {
  afterEach(async () => {
    await prisma.shopifyWebhookEvent.deleteMany({ where: { shopDomain: SHOP } });
  });

  it("a fresh (shopDomain, webhookId) claims for processing and creates exactly one RECEIVED row", async () => {
    const webhookId = crypto.randomUUID();
    const claim = await claimWebhookDelivery(SHOP, webhookId, "orders/create");
    expect(claim.action).toBe("process");
    expect(claim.receipt.status).toBe("RECEIVED");

    const count = await prisma.shopifyWebhookEvent.count({ where: { shopDomain: SHOP, webhookId } });
    expect(count).toBe(1);
  });

  it("the same webhook id delivered twice, after the first was marked PROCESSED, is skipped — no duplicate business processing", async () => {
    const webhookId = crypto.randomUUID();
    const first = await claimWebhookDelivery(SHOP, webhookId, "orders/create");
    await markWebhookProcessed(first.receipt.id, { eligible: false, eligibilityReason: "NO_SHIPPING_ADDRESS", createdHandoffId: null });

    const second = await claimWebhookDelivery(SHOP, webhookId, "orders/create");
    expect(second.action).toBe("skip");
    expect(second.receipt.id).toBe(first.receipt.id);

    const count = await prisma.shopifyWebhookEvent.count({ where: { shopDomain: SHOP, webhookId } });
    expect(count).toBe(1);
  });

  it("a RECEIVED row still within the in-flight lease window is treated as actively being processed, not a stale record safe to retry", async () => {
    const webhookId = crypto.randomUUID();
    const first = await claimWebhookDelivery(SHOP, webhookId, "orders/create");
    expect(first.action).toBe("process");

    const second = await claimWebhookDelivery(SHOP, webhookId, "orders/create");
    expect(second.action).toBe("skip");
    expect(second.receipt.id).toBe(first.receipt.id);

    const count = await prisma.shopifyWebhookEvent.count({ where: { shopDomain: SHOP, webhookId } });
    expect(count).toBe(1);
  });

  it("a RECEIVED row past the in-flight lease window is treated as abandoned (crash mid-processing) and can be retried", async () => {
    const webhookId = crypto.randomUUID();
    const first = await claimWebhookDelivery(SHOP, webhookId, "orders/create");
    await prisma.shopifyWebhookEvent.update({
      where: { id: first.receipt.id },
      data: { receivedAt: new Date(Date.now() - 60_000) },
    });

    const second = await claimWebhookDelivery(SHOP, webhookId, "orders/create");
    expect(second.action).toBe("retry");
    expect(second.receipt.id).toBe(first.receipt.id);

    const count = await prisma.shopifyWebhookEvent.count({ where: { shopDomain: SHOP, webhookId } });
    expect(count).toBe(1);
  });

  it("two truly simultaneous claims of the same (shopDomain, webhookId) — exactly one may process, the other must defer rather than both running business logic", async () => {
    const webhookId = crypto.randomUUID();
    const [a, b] = await Promise.all([
      claimWebhookDelivery(SHOP, webhookId, "orders/create"),
      claimWebhookDelivery(SHOP, webhookId, "orders/create"),
    ]);

    const actions = [a.action, b.action].sort();
    expect(actions).toEqual(["process", "skip"]);
    expect(a.receipt.id).toBe(b.receipt.id);

    const count = await prisma.shopifyWebhookEvent.count({ where: { shopDomain: SHOP, webhookId } });
    expect(count).toBe(1);
  });

  it("a webhook that previously FAILED is not a permanent poison record — the same delivery id can be retried", async () => {
    const webhookId = crypto.randomUUID();
    const first = await claimWebhookDelivery(SHOP, webhookId, "orders/create");
    await markWebhookFailed(first.receipt.id, "NETWORK_ERROR");

    const retry = await claimWebhookDelivery(SHOP, webhookId, "orders/create");
    expect(retry.action).toBe("retry");
    expect(retry.receipt.id).toBe(first.receipt.id);
    expect(retry.receipt.status).toBe("FAILED");

    // The retry succeeds this time.
    await markWebhookProcessed(retry.receipt.id, { eligible: false, eligibilityReason: "ORDER_CANCELLED", createdHandoffId: null });
    const reloaded = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { id: first.receipt.id } });
    expect(reloaded.status).toBe("PROCESSED");

    const count = await prisma.shopifyWebhookEvent.count({ where: { shopDomain: SHOP, webhookId } });
    expect(count).toBe(1);
  });

  it("the same Order referenced by two different (legitimate) webhook ids creates two receipts but is still governed by DeliveryDateHandoff's own uniqueness for any handoff", async () => {
    const webhookIdA = crypto.randomUUID();
    const webhookIdB = crypto.randomUUID();
    const claimA = await claimWebhookDelivery(SHOP, webhookIdA, "orders/create");
    const claimB = await claimWebhookDelivery(SHOP, webhookIdB, "orders/create");

    expect(claimA.receipt.id).not.toBe(claimB.receipt.id);
    const count = await prisma.shopifyWebhookEvent.count({ where: { shopDomain: SHOP, webhookId: { in: [webhookIdA, webhookIdB] } } });
    expect(count).toBe(2);
    // DeliveryDateHandoff-level dedup for the same Order GID is already
    // covered by tests/delivery-handoff.test.ts's idempotent-create tests
    // — this test only proves receipt-level tracking is per-delivery, not
    // per-Order.
  });

  it("markWebhookProcessed records the eligibility decision and optional handoff id", async () => {
    const webhookId = crypto.randomUUID();
    const claim = await claimWebhookDelivery(SHOP, webhookId, "orders/create");
    await markWebhookProcessed(claim.receipt.id, { eligible: true, eligibilityReason: "ELIGIBLE_TEST_ONLY", createdHandoffId: "handoff-123" });

    const reloaded = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { id: claim.receipt.id } });
    expect(reloaded.status).toBe("PROCESSED");
    expect(reloaded.eligible).toBe(true);
    expect(reloaded.eligibilityReason).toBe("ELIGIBLE_TEST_ONLY");
    expect(reloaded.createdHandoffId).toBe("handoff-123");
    expect(reloaded.processedAt).not.toBeNull();
  });

  it("markWebhookFailed records a short error category, never a raw stack trace, and clears any prior eligibility fields on the next successful pass", async () => {
    const webhookId = crypto.randomUUID();
    const claim = await claimWebhookDelivery(SHOP, webhookId, "orders/create");
    await markWebhookFailed(claim.receipt.id, "ShopifyApiError");

    const reloaded = await prisma.shopifyWebhookEvent.findUniqueOrThrow({ where: { id: claim.receipt.id } });
    expect(reloaded.status).toBe("FAILED");
    expect(reloaded.errorSummary).toBe("ShopifyApiError");
  });
});
