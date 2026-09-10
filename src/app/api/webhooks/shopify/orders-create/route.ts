import { NextRequest, NextResponse } from "next/server";
import { intakeShopifyOrderWebhook } from "@/modules/delivery/webhook-intake";
import { processOrderWebhookEvent } from "@/modules/delivery/order-webhook-processing";

// Phase 6C — Shopify ORDERS_CREATE webhook intake, refactored in Phase 6F
// onto the shared intake/processing modules it now has in common with
// ORDERS_PAID (build instruction §2 — reuse the proven security and
// receipt mechanisms rather than duplicating them per topic). Behavior is
// unchanged apart from the decision engine: what used to be the Phase 6C
// eligibility check is now evaluateDeliveryRequestDecision() with the
// ORDER_CREATED trigger, which subsumes those same negatives and adds the
// payment/classification layers (see delivery-request-decision.ts).
//
// This route sends NO email, writes NO requested_delivery_date, and
// performs NO Shopify mutation of any kind. ORDERS_CREATE means "an Order
// now exists, re-evaluate it" — never "ask the customer for a date".
//
// A rejected/unauthenticated request is deliberately never distinguished
// in its response body (no detail on *why* it failed) — same "don't leak
// which check failed" discipline as the public /delivery/[token] route's
// generic 404.

const EXPECTED_TOPIC_VARIANTS: ReadonlySet<string> = new Set(["orders/create", "ORDERS_CREATE"]);

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  const intake = await intakeShopifyOrderWebhook({
    rawBody,
    headers: {
      hmac: request.headers.get("x-shopify-hmac-sha256"),
      shopDomain: request.headers.get("x-shopify-shop-domain"),
      topic: request.headers.get("x-shopify-topic"),
      webhookId: request.headers.get("x-shopify-webhook-id"),
    },
    expectedTopics: EXPECTED_TOPIC_VARIANTS,
  });

  if (intake.outcome === "REJECTED") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (intake.outcome === "DUPLICATE") {
    return NextResponse.json({ status: "already processed" }, { status: 200 });
  }
  if (intake.outcome === "INVALID_PAYLOAD") {
    // Malformed body despite a valid HMAC can't be Shopify's own payload —
    // treat as a permanent rejection, not a transient-retry case.
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const result = await processOrderWebhookEvent({
    receiptId: intake.receiptId,
    orderGid: intake.orderGid,
    trigger: "ORDER_CREATED",
  });

  if (result.outcome === "ORDER_NOT_READABLE") {
    // Plausibly a read-after-write race (the webhook can arrive before the
    // Order is consistently readable) — a retry-permitting response, so
    // Shopify's own redelivery gives this a real second attempt.
    return NextResponse.json({ error: "order not yet readable" }, { status: 500 });
  }
  if (result.outcome === "FAILED") {
    console.error("shopify_orders_create_webhook_failed", result.errorCode);
    // Transient failure — 500 lets Shopify's built-in retry (up to 8
    // attempts over 4 hours) resume safely; the FAILED receipt status
    // means the redelivery is allowed to reprocess rather than being
    // treated as already-handled.
    return NextResponse.json({ error: "processing error" }, { status: 500 });
  }

  return NextResponse.json({ status: "recorded", shouldRequest: result.decision.shouldRequest }, { status: 200 });
}
