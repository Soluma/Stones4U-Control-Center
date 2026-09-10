import { NextRequest, NextResponse } from "next/server";
import { intakeShopifyOrderWebhook } from "@/modules/delivery/webhook-intake";
import { processOrderWebhookEvent } from "@/modules/delivery/order-webhook-processing";

// Phase 6F — Shopify ORDERS_PAID webhook intake. Topic verified live
// against this API version's WebhookSubscriptionTopic enum (build
// instruction §3), never assumed; both the REST-style header spelling
// (`orders/paid`) and the enum spelling are accepted defensively, the same
// way Phase 6C handled ORDERS_CREATE.
//
// ORDERS_PAID is a wake-up signal, not an instruction: it means "this
// Order's payment state may have changed, re-evaluate it" — never "create
// a handoff" and never "email the customer" (build instruction §4). The
// payment state that actually decides anything is re-read live from the
// canonical Order (`fullyPaid`), never inferred from the fact that a
// webhook named "paid" arrived.
//
// Identical security, idempotency and processing path as ORDERS_CREATE —
// literally the same two shared modules, differing only in the recorded
// trigger. Sends NO email, writes NO requested_delivery_date, performs NO
// Shopify mutation, creates NO customer-facing Activity.

const EXPECTED_TOPIC_VARIANTS: ReadonlySet<string> = new Set(["orders/paid", "ORDERS_PAID"]);

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
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const result = await processOrderWebhookEvent({
    receiptId: intake.receiptId,
    orderGid: intake.orderGid,
    trigger: "ORDER_PAID",
  });

  if (result.outcome === "ORDER_NOT_READABLE") {
    return NextResponse.json({ error: "order not yet readable" }, { status: 500 });
  }
  if (result.outcome === "FAILED") {
    console.error("shopify_orders_paid_webhook_failed", result.errorCode);
    return NextResponse.json({ error: "processing error" }, { status: 500 });
  }

  return NextResponse.json({ status: "recorded", shouldRequest: result.decision.shouldRequest }, { status: 200 });
}
