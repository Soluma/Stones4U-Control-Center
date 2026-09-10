import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Phase 6F — same source-text technique as
// tests/delivery-route-dispatch.test.ts (this repo has no route-level HTTP
// test pipeline). Confirms both Order-scoped webhook routes are thin
// wrappers around the shared intake/processing modules (build instruction
// §2 — no duplicated HMAC/shop/topic/idempotency logic per topic), use the
// correct topic set each, and never touch email/Shopify mutations.

const createRoutePath = fileURLToPath(new URL("../src/app/api/webhooks/shopify/orders-create/route.ts", import.meta.url));
const paidRoutePath = fileURLToPath(new URL("../src/app/api/webhooks/shopify/orders-paid/route.ts", import.meta.url));
const createSource = readFileSync(createRoutePath, "utf-8");
const paidSource = readFileSync(paidRoutePath, "utf-8");

describe("both Order webhook routes reuse the shared intake/processing modules — no duplicated security logic", () => {
  for (const [name, source] of [
    ["orders-create", createSource],
    ["orders-paid", paidSource],
  ] as const) {
    it(`${name}/route.ts delegates to intakeShopifyOrderWebhook() and processOrderWebhookEvent(), never re-implementing HMAC/shop/topic checks inline`, () => {
      expect(source).toContain("intakeShopifyOrderWebhook(");
      expect(source).toContain("processOrderWebhookEvent(");
      expect(source).not.toContain("verifyShopifyWebhookHmac(");
      expect(source).not.toContain("isExpectedWebhookShopDomain(");
      expect(source).not.toContain("claimWebhookDelivery(");
      expect(source).not.toContain("JSON.parse(");
    });

    it(`${name}/route.ts never sends email, never mutates Shopify, never writes requested_delivery_date`, () => {
      expect(source).not.toMatch(/\bmail\b/i);
      expect(source).not.toContain("mirrorRequestedDeliveryDateToOrder");
      expect(source).not.toContain("orderUpdate");
      expect(source).not.toContain("draftOrderUpdate");
      expect(source).not.toMatch(/gid:\/\/shopify/i);
    });

    it(`${name}/route.ts never leaks internal error detail — every failure response uses a fixed generic string`, () => {
      expect(source).not.toMatch(/error\.stack/);
      expect(source).not.toMatch(/error\.message/);
    });
  }

  it("orders-create expects the orders/create topic (both header spellings), not orders/paid", () => {
    expect(createSource).toContain('"orders/create"');
    expect(createSource).toContain('"ORDERS_CREATE"');
    expect(createSource).not.toContain('"orders/paid"');
    expect(createSource).not.toContain('"ORDERS_PAID"');
  });

  it("orders-paid expects the orders/paid topic (both header spellings), not orders/create", () => {
    expect(paidSource).toContain('"orders/paid"');
    expect(paidSource).toContain('"ORDERS_PAID"');
    expect(paidSource).not.toContain('"orders/create"');
    expect(paidSource).not.toContain('"ORDERS_CREATE"');
  });

  it("orders-create records the ORDER_CREATED trigger; orders-paid records ORDER_PAID — never the other's", () => {
    expect(createSource).toContain('"ORDER_CREATED"');
    expect(createSource).not.toContain('"ORDER_PAID"');
    expect(paidSource).toContain('"ORDER_PAID"');
    expect(paidSource).not.toContain('"ORDER_CREATED"');
  });

  it("both routes map every intake/processing outcome to the correct HTTP status — reject 401, duplicate 200, invalid payload 400, not-readable/failed 500, processed 200", () => {
    for (const source of [createSource, paidSource]) {
      expect(source).toMatch(/REJECTED[\s\S]{0,150}status:\s*401/);
      expect(source).toMatch(/DUPLICATE[\s\S]{0,150}status:\s*200/);
      expect(source).toMatch(/INVALID_PAYLOAD[\s\S]{0,300}status:\s*400/);
      expect(source).toMatch(/ORDER_NOT_READABLE[\s\S]{0,300}status:\s*500/);
      expect(source).toMatch(/outcome === "FAILED"[\s\S]{0,400}status:\s*500/);
      expect(source).toMatch(/shouldRequest:\s*result\.decision\.shouldRequest[\s\S]{0,40}status:\s*200/);
    }
  });
});
