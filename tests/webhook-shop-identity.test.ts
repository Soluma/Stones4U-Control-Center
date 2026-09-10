import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isExpectedWebhookShopDomain } from "@/integrations/shopify/webhook-shop-identity";

describe("isExpectedWebhookShopDomain", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN;
    process.env.SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN = "stones4u-dev.myshopify.com";
  });

  afterEach(() => {
    if (original === undefined) delete process.env.SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN;
    else process.env.SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN = original;
  });

  it("accepts the exact configured staging shop", () => {
    expect(isExpectedWebhookShopDomain("stones4u-dev.myshopify.com")).toBe(true);
  });

  it("rejects the production shop when staging is configured", () => {
    expect(isExpectedWebhookShopDomain("9h7x2c-ku.myshopify.com")).toBe(false);
  });

  it("rejects an evil lookalike domain", () => {
    expect(isExpectedWebhookShopDomain("evil-stones4u-dev.myshopify.com")).toBe(false);
    expect(isExpectedWebhookShopDomain("stones4u-dev.myshopify.com.evil.com")).toBe(false);
  });

  it("rejects a subdomain-suffix trick", () => {
    expect(isExpectedWebhookShopDomain("xstones4u-dev.myshopify.com")).toBe(false);
    expect(isExpectedWebhookShopDomain("stones4u-dev.myshopify.com.attacker.net")).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(isExpectedWebhookShopDomain(null)).toBe(false);
    expect(isExpectedWebhookShopDomain(undefined)).toBe(false);
    expect(isExpectedWebhookShopDomain("")).toBe(false);
  });

  it("normalizes casing only (not a subdomain/suffix relaxation)", () => {
    expect(isExpectedWebhookShopDomain("STONES4U-DEV.MYSHOPIFY.COM")).toBe(true);
  });

  it("fails closed when no expected domain is configured at all", () => {
    delete process.env.SHOPIFY_EXPECTED_MYSHOPIFY_DOMAIN;
    expect(isExpectedWebhookShopDomain("stones4u-dev.myshopify.com")).toBe(false);
  });
});
