import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyShopifyWebhookHmac } from "@/integrations/shopify/webhook-verify";

const SECRET = "test-client-secret";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

describe("verifyShopifyWebhookHmac", () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.SHOPIFY_CLIENT_SECRET;
    process.env.SHOPIFY_CLIENT_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.SHOPIFY_CLIENT_SECRET;
    else process.env.SHOPIFY_CLIENT_SECRET = originalSecret;
  });

  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ id: 123, note: "hello" });
    expect(verifyShopifyWebhookHmac(body, sign(body))).toBe(true);
  });

  it("rejects a missing HMAC header", () => {
    const body = JSON.stringify({ id: 123 });
    expect(verifyShopifyWebhookHmac(body, null)).toBe(false);
    expect(verifyShopifyWebhookHmac(body, undefined)).toBe(false);
  });

  it("rejects a malformed HMAC header", () => {
    const body = JSON.stringify({ id: 123 });
    expect(verifyShopifyWebhookHmac(body, "not-valid-base64!!!")).toBe(false);
  });

  it("rejects when signed with the wrong secret", () => {
    const body = JSON.stringify({ id: 123 });
    expect(verifyShopifyWebhookHmac(body, sign(body, "a-different-secret"))).toBe(false);
  });

  it("rejects when the body changes after signing — even a single whitespace character", () => {
    const original = JSON.stringify({ id: 123, note: "hello" });
    const signature = sign(original);

    const tamperedWhitespace = original.replace('"id"', '"id" ');
    expect(verifyShopifyWebhookHmac(tamperedWhitespace, signature)).toBe(false);

    const tamperedKeyOrder = JSON.stringify({ note: "hello", id: 123 });
    expect(verifyShopifyWebhookHmac(tamperedKeyOrder, signature)).toBe(false);

    const tamperedValue = JSON.stringify({ id: 124, note: "hello" });
    expect(verifyShopifyWebhookHmac(tamperedValue, signature)).toBe(false);
  });

  it("fails closed when SHOPIFY_CLIENT_SECRET is missing", () => {
    delete process.env.SHOPIFY_CLIENT_SECRET;
    const body = JSON.stringify({ id: 123 });
    expect(verifyShopifyWebhookHmac(body, sign(body))).toBe(false);
  });

  it("rejects a shorter, truncated signature rather than throwing", () => {
    const body = JSON.stringify({ id: 123 });
    const full = sign(body);
    expect(() => verifyShopifyWebhookHmac(body, full.slice(0, 10))).not.toThrow();
    expect(verifyShopifyWebhookHmac(body, full.slice(0, 10))).toBe(false);
  });
});
