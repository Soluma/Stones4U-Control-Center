import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6F — tests the shared intake orchestration itself
// (intakeShopifyOrderWebhook), mocking its three collaborators the same
// way tests/delivery-handoff.test.ts mocks the Shopify mirror functions —
// this keeps the test focused on ordering/branching logic, since HMAC and
// shop-identity correctness are already exhaustively covered in
// tests/webhook-verify.test.ts and tests/webhook-shop-identity.test.ts,
// and claimWebhookDelivery's own concurrency guarantees in
// tests/webhook-receipt.test.ts.

const mockVerifyHmac = vi.fn();
vi.mock("@/integrations/shopify/webhook-verify", () => ({
  verifyShopifyWebhookHmac: (...args: unknown[]) => mockVerifyHmac(...args),
}));

const mockShopDomain = vi.fn();
vi.mock("@/integrations/shopify/webhook-shop-identity", () => ({
  isExpectedWebhookShopDomain: (...args: unknown[]) => mockShopDomain(...args),
}));

const mockClaim = vi.fn();
const mockMarkFailed = vi.fn();
vi.mock("@/modules/delivery/webhook-receipt.service", () => ({
  claimWebhookDelivery: (...args: unknown[]) => mockClaim(...args),
  markWebhookFailed: (...args: unknown[]) => mockMarkFailed(...args),
}));

const EXPECTED_TOPICS = new Set(["orders/paid", "ORDERS_PAID"]);

function headers(overrides: Partial<{ hmac: string | null; shopDomain: string | null; topic: string | null; webhookId: string | null }> = {}) {
  return {
    hmac: "valid-hmac",
    shopDomain: "stones4u-dev.myshopify.com",
    topic: "orders/paid",
    webhookId: "wh-1",
    ...overrides,
  };
}

describe("intakeShopifyOrderWebhook — verification order and branching", () => {
  beforeEach(() => {
    mockVerifyHmac.mockReset().mockReturnValue(true);
    mockShopDomain.mockReset().mockReturnValue(true);
    mockClaim.mockReset().mockResolvedValue({ action: "process", receipt: { id: "receipt-1" } });
    mockMarkFailed.mockReset();
  });

  it("rejects an invalid HMAC before checking anything else — shop identity and topic are never consulted", async () => {
    mockVerifyHmac.mockReturnValue(false);
    const { intakeShopifyOrderWebhook } = await import("@/modules/delivery/webhook-intake");

    const result = await intakeShopifyOrderWebhook({ rawBody: "{}", headers: headers(), expectedTopics: EXPECTED_TOPICS });

    expect(result).toEqual({ outcome: "REJECTED", reason: "INVALID_HMAC" });
    expect(mockShopDomain).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("checks shop identity only after HMAC succeeds", async () => {
    mockShopDomain.mockReturnValue(false);
    const { intakeShopifyOrderWebhook } = await import("@/modules/delivery/webhook-intake");

    const result = await intakeShopifyOrderWebhook({ rawBody: "{}", headers: headers(), expectedTopics: EXPECTED_TOPICS });

    expect(result).toEqual({ outcome: "REJECTED", reason: "WRONG_SHOP" });
    expect(mockVerifyHmac).toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("rejects an unexpected topic — checked against the header value, never the URL", async () => {
    const { intakeShopifyOrderWebhook } = await import("@/modules/delivery/webhook-intake");
    const result = await intakeShopifyOrderWebhook({
      rawBody: "{}",
      headers: headers({ topic: "orders/create" }),
      expectedTopics: EXPECTED_TOPICS,
    });
    expect(result).toEqual({ outcome: "REJECTED", reason: "UNEXPECTED_TOPIC" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("rejects a missing topic header", async () => {
    const { intakeShopifyOrderWebhook } = await import("@/modules/delivery/webhook-intake");
    const result = await intakeShopifyOrderWebhook({ rawBody: "{}", headers: headers({ topic: null }), expectedTopics: EXPECTED_TOPICS });
    expect(result).toEqual({ outcome: "REJECTED", reason: "UNEXPECTED_TOPIC" });
  });

  it("rejects a missing webhook id — nothing to dedupe against", async () => {
    const { intakeShopifyOrderWebhook } = await import("@/modules/delivery/webhook-intake");
    const result = await intakeShopifyOrderWebhook({ rawBody: "{}", headers: headers({ webhookId: null }), expectedTopics: EXPECTED_TOPICS });
    expect(result).toEqual({ outcome: "REJECTED", reason: "MISSING_WEBHOOK_ID" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("returns DUPLICATE when the claim says skip, without ever parsing the body", async () => {
    mockClaim.mockResolvedValue({ action: "skip", receipt: { id: "receipt-1" } });
    const { intakeShopifyOrderWebhook } = await import("@/modules/delivery/webhook-intake");
    const result = await intakeShopifyOrderWebhook({
      rawBody: "not even json",
      headers: headers(),
      expectedTopics: EXPECTED_TOPICS,
    });
    expect(result).toEqual({ outcome: "DUPLICATE" });
  });

  it("marks the receipt FAILED and returns INVALID_PAYLOAD for malformed JSON, after a successful claim", async () => {
    const { intakeShopifyOrderWebhook } = await import("@/modules/delivery/webhook-intake");
    const result = await intakeShopifyOrderWebhook({
      rawBody: "{not valid json",
      headers: headers(),
      expectedTopics: EXPECTED_TOPICS,
    });
    expect(result).toEqual({ outcome: "INVALID_PAYLOAD", reason: "INVALID_JSON_PAYLOAD" });
    expect(mockMarkFailed).toHaveBeenCalledWith("receipt-1", "INVALID_JSON_PAYLOAD");
  });

  it("marks the receipt FAILED and returns INVALID_PAYLOAD for a non-numeric order id", async () => {
    const { intakeShopifyOrderWebhook } = await import("@/modules/delivery/webhook-intake");
    const result = await intakeShopifyOrderWebhook({
      rawBody: JSON.stringify({ id: "not-a-number" }),
      headers: headers(),
      expectedTopics: EXPECTED_TOPICS,
    });
    expect(result).toEqual({ outcome: "INVALID_PAYLOAD", reason: "INVALID_ORDER_ID_FORMAT" });
    expect(mockMarkFailed).toHaveBeenCalledWith("receipt-1", "INVALID_ORDER_ID_FORMAT");
  });

  it("returns READY with a server-derived GID for a valid numeric id, never trusting a client-shaped GID directly", async () => {
    const { intakeShopifyOrderWebhook } = await import("@/modules/delivery/webhook-intake");
    const result = await intakeShopifyOrderWebhook({
      rawBody: JSON.stringify({ id: 123456, "malicious-gid-override": "gid://shopify/Order/999" }),
      headers: headers(),
      expectedTopics: EXPECTED_TOPICS,
    });
    expect(result).toEqual({
      outcome: "READY",
      receiptId: "receipt-1",
      orderGid: "gid://shopify/Order/123456",
      shopDomain: "stones4u-dev.myshopify.com",
      topic: "orders/paid",
    });
  });

  it("accepts a string-shaped numeric id too", async () => {
    const { intakeShopifyOrderWebhook } = await import("@/modules/delivery/webhook-intake");
    const result = await intakeShopifyOrderWebhook({
      rawBody: JSON.stringify({ id: "123456" }),
      headers: headers(),
      expectedTopics: EXPECTED_TOPICS,
    });
    expect(result.outcome).toBe("READY");
    if (result.outcome === "READY") {
      expect(result.orderGid).toBe("gid://shopify/Order/123456");
    }
  });

  it("passes the claim through with the exact shop/webhookId/topic from the headers", async () => {
    const { intakeShopifyOrderWebhook } = await import("@/modules/delivery/webhook-intake");
    await intakeShopifyOrderWebhook({
      rawBody: JSON.stringify({ id: 1 }),
      headers: headers({ shopDomain: "stones4u-dev.myshopify.com", webhookId: "wh-42", topic: "ORDERS_PAID" }),
      expectedTopics: EXPECTED_TOPICS,
    });
    expect(mockClaim).toHaveBeenCalledWith("stones4u-dev.myshopify.com", "wh-42", "ORDERS_PAID");
  });
});
