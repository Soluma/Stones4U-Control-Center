import "server-only";
import { verifyShopifyWebhookHmac } from "@/integrations/shopify/webhook-verify";
import { isExpectedWebhookShopDomain } from "@/integrations/shopify/webhook-shop-identity";
import { claimWebhookDelivery, markWebhookFailed } from "./webhook-receipt.service";

// Phase 6F — the shared, HTTP-agnostic intake for every Shopify
// Order-scoped webhook (build instruction §2: reuse the proven security
// and receipt mechanisms rather than duplicating them per topic). Phase
// 6C's ORDERS_CREATE route grew this logic inline; ORDERS_PAID needs it
// identically, so it now lives here — one implementation, one place to
// audit, and (unlike route code, which this repo deliberately does not
// unit-test) directly testable at the module layer.
//
// Deliberately returns plain typed results and never a NextResponse: the
// routes own the HTTP mapping, this module owns the security and
// idempotency decisions (CLAUDE.md — routes stay thin, modules hold logic).
//
// The verification order is fixed and must never be reordered: HMAC →
// shop identity → topic → webhook id → idempotency claim → payload parse
// → trusted Order id. Nothing is persisted at all for a request that
// fails HMAC, shop-identity or topic verification — there is nothing to
// dedupe or retry for a sender that was never proven authentic.

export type ShopifyWebhookHeaders = {
  hmac: string | null;
  shopDomain: string | null;
  topic: string | null;
  webhookId: string | null;
};

export type WebhookIntakeResult =
  /** Never authenticated — reject without persisting anything. */
  | { outcome: "REJECTED"; reason: "INVALID_HMAC" | "WRONG_SHOP" | "UNEXPECTED_TOPIC" | "MISSING_WEBHOOK_ID" }
  /** Authentic, but this exact delivery is already handled (or is being
   * handled right now by a concurrent request) — success, no reprocessing. */
  | { outcome: "DUPLICATE" }
  /** Authentic, claimed, but the body could not yield a trusted Order id.
   * The receipt is already marked FAILED by the time this returns. */
  | { outcome: "INVALID_PAYLOAD"; reason: "INVALID_JSON_PAYLOAD" | "INVALID_ORDER_ID_FORMAT" }
  /** Authentic, claimed, and carrying a server-derived, trusted Order GID. */
  | { outcome: "READY"; receiptId: string; orderGid: string; shopDomain: string; topic: string };

/**
 * Verifies, claims and parses one Shopify Order webhook delivery.
 *
 * `expectedTopics` is matched against the `X-Shopify-Topic` header, never
 * against the URL path — routing is not authentication. Both the REST-style
 * (`orders/paid`) and enum-style (`ORDERS_PAID`) spellings are accepted
 * defensively, the same way Phase 6C handled ORDERS_CREATE before the live
 * value was confirmed.
 */
export async function intakeShopifyOrderWebhook(input: {
  rawBody: string;
  headers: ShopifyWebhookHeaders;
  expectedTopics: ReadonlySet<string>;
}): Promise<WebhookIntakeResult> {
  const { rawBody, headers, expectedTopics } = input;

  if (!verifyShopifyWebhookHmac(rawBody, headers.hmac)) {
    return { outcome: "REJECTED", reason: "INVALID_HMAC" };
  }
  // Only ever trusted *after* the HMAC proves the request really came from
  // the app's own Shopify shop.
  if (!isExpectedWebhookShopDomain(headers.shopDomain)) {
    return { outcome: "REJECTED", reason: "WRONG_SHOP" };
  }
  if (!headers.topic || !expectedTopics.has(headers.topic)) {
    return { outcome: "REJECTED", reason: "UNEXPECTED_TOPIC" };
  }
  if (!headers.webhookId) {
    return { outcome: "REJECTED", reason: "MISSING_WEBHOOK_ID" };
  }

  const shopDomain = headers.shopDomain!;
  const claim = await claimWebhookDelivery(shopDomain, headers.webhookId, headers.topic);
  if (claim.action === "skip") {
    return { outcome: "DUPLICATE" };
  }

  let payload: { id?: number | string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    await markWebhookFailed(claim.receipt.id, "INVALID_JSON_PAYLOAD");
    return { outcome: "INVALID_PAYLOAD", reason: "INVALID_JSON_PAYLOAD" };
  }

  const rawId = payload.id;
  const isValidNumericOrderId =
    (typeof rawId === "number" && Number.isInteger(rawId) && rawId > 0) ||
    (typeof rawId === "string" && /^[1-9]\d*$/.test(rawId));
  if (!isValidNumericOrderId) {
    await markWebhookFailed(claim.receipt.id, "INVALID_ORDER_ID_FORMAT");
    return { outcome: "INVALID_PAYLOAD", reason: "INVALID_ORDER_ID_FORMAT" };
  }

  // Numeric REST-style id → GraphQL GID. Server-derived only, from the
  // HMAC-verified payload's validated-numeric id — never accepted from any
  // client-supplied value, and never built from an unvalidated format.
  return {
    outcome: "READY",
    receiptId: claim.receipt.id,
    orderGid: `gid://shopify/Order/${rawId}`,
    shopDomain,
    topic: headers.topic,
  };
}
