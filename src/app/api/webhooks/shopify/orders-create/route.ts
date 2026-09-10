import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/platform/db/prisma";
import { verifyShopifyWebhookHmac } from "@/integrations/shopify/webhook-verify";
import { isExpectedWebhookShopDomain } from "@/integrations/shopify/webhook-shop-identity";
import { getOrderForHandoff } from "@/integrations/shopify/order-for-handoff";
import { evaluateDeliveryDateEligibility } from "@/modules/delivery/eligibility";
import { claimWebhookDelivery, markWebhookProcessed, markWebhookFailed } from "@/modules/delivery/webhook-receipt.service";
import { createOrGetOrderDeliveryHandoff } from "@/modules/delivery/delivery-handoff.service";

// DeliveryDateHandoff.createdById is a required FK to User — there is no
// "system actor" concept anywhere in this codebase yet. This resolves to
// the first active ADMIN as a stand-in attribution, exactly like every
// bootstrap/verification script this engagement has used when it needed
// *a* real staff id rather than inventing one. This branch is not
// currently reachable (see eligibility.ts — no live Order is ever
// classified `eligible: true` yet), so this is a placeholder for a real
// decision ("who owns an automatically-created handoff?") to make before
// the eligibility rule is ever loosened — not a design this phase asks to
// finalize.
async function resolveWebhookCreatedById(): Promise<string | null> {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, select: { id: true } });
  return admin?.id ?? null;
}

// Phase 6C — Shopify ORDERS_CREATE webhook intake. This route sends NO
// email, writes NO requested_delivery_date, and performs NO Shopify
// mutation of any kind — it only ever (a) verifies the request is
// authentically from the configured Shopify shop, (b) records receipt for
// idempotency, (c) re-reads the Order (a Shopify READ), (d) classifies
// eligibility, and (e) — only if genuinely eligible, which no real Order
// can be yet in this phase, see eligibility.ts — creates a local
// DeliveryDateHandoff row via the same, already-proven service function
// the manual staff path uses.
//
// Required processing order, never reordered: raw body → HMAC → shop
// identity → topic → idempotency claim → parse → derive Order GID →
// re-read → eligibility → (optional) handoff. A request that fails HMAC,
// shop-identity, or topic verification is rejected before anything is
// persisted at all — there is nothing to dedupe or retry for a sender
// that was never proven authentic.
//
// A rejected/unauthenticated request is deliberately never distinguished
// in its response body (no detail on *why* it failed) — same "don't leak
// which check failed" discipline as the public /delivery/[token] route's
// generic 404.

const EXPECTED_TOPIC_VARIANTS = new Set(["orders/create", "ORDERS_CREATE"]);

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  const hmacHeader = request.headers.get("x-shopify-hmac-sha256");
  if (!verifyShopifyWebhookHmac(rawBody, hmacHeader)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const shopDomainHeader = request.headers.get("x-shopify-shop-domain");
  if (!isExpectedWebhookShopDomain(shopDomainHeader)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const topicHeader = request.headers.get("x-shopify-topic");
  if (!topicHeader || !EXPECTED_TOPIC_VARIANTS.has(topicHeader)) {
    return NextResponse.json({ error: "unexpected topic" }, { status: 401 });
  }

  const webhookId = request.headers.get("x-shopify-webhook-id");
  if (!webhookId) {
    return NextResponse.json({ error: "missing webhook id" }, { status: 401 });
  }

  const claim = await claimWebhookDelivery(shopDomainHeader!, webhookId, topicHeader);
  if (claim.action === "skip") {
    return NextResponse.json({ status: "already processed" }, { status: 200 });
  }

  let payload: { id?: number | string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    await markWebhookFailed(claim.receipt.id, "INVALID_JSON_PAYLOAD");
    // Malformed body despite a valid HMAC can't be Shopify's own payload —
    // treat as a permanent rejection, not a transient-retry case.
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const rawId = payload.id;
  const isValidNumericOrderId =
    (typeof rawId === "number" && Number.isInteger(rawId) && rawId > 0) ||
    (typeof rawId === "string" && /^[1-9]\d*$/.test(rawId));
  if (!isValidNumericOrderId) {
    await markWebhookFailed(claim.receipt.id, "INVALID_ORDER_ID_FORMAT");
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  // Numeric REST-style id → GraphQL GID. Server-derived only, from the
  // HMAC-verified payload's validated-numeric id — never accepted from any
  // client-supplied value, and never built from an unvalidated format.
  const orderGid = `gid://shopify/Order/${rawId}`;

  try {
    // Shopify READ only — the webhook payload can be stale or carry more
    // than this feature needs; the live Order is the canonical source for
    // the eligibility decision.
    const order = await getOrderForHandoff(orderGid);
    if (!order) {
      await markWebhookFailed(claim.receipt.id, "ORDER_NOT_FOUND_ON_REREAD");
      // Plausibly a read-after-write race (the webhook can arrive before the
      // Order is consistently readable) rather than a permanent condition —
      // treated the same as any other transient failure below: a
      // retry-permitting response, so Shopify's own redelivery gives this a
      // real second attempt instead of the FAILED status above only ever
      // being revisited by an unrelated network-level duplicate delivery.
      return NextResponse.json({ error: "order not yet readable" }, { status: 500 });
    }

    const decision = evaluateDeliveryDateEligibility(order);

    let createdHandoffId: string | null = null;
    if (decision.eligible) {
      // No live code path produces eligible: true yet (see eligibility.ts)
      // — this branch exists so a future, more permissive eligibility
      // rule does not also require route changes.
      const createdById = await resolveWebhookCreatedById();
      if (!createdById) {
        throw new Error("NO_ACTIVE_ADMIN_TO_ATTRIBUTE_WEBHOOK_HANDOFF");
      }
      const { handoff } = await createOrGetOrderDeliveryHandoff({
        shopifyOrderGid: order.gid,
        publicReference: order.name,
        customerProfileId: null,
        createdById,
      });
      createdHandoffId = handoff.id;
    }

    await markWebhookProcessed(claim.receipt.id, {
      eligible: decision.eligible,
      eligibilityReason: decision.reason,
      createdHandoffId,
    });

    return NextResponse.json({ status: "recorded", eligible: decision.eligible }, { status: 200 });
  } catch (error) {
    const errorCode = error instanceof Error ? error.name : "UNKNOWN_ERROR";
    await markWebhookFailed(claim.receipt.id, errorCode);
    console.error("shopify_orders_create_webhook_failed", errorCode);
    // Transient failure — 500 lets Shopify's built-in retry (up to 8
    // attempts over 4 hours) resume safely; the FAILED status above means
    // the redelivery will be allowed to reprocess rather than being
    // treated as already-handled.
    return NextResponse.json({ error: "processing error" }, { status: 500 });
  }
}
