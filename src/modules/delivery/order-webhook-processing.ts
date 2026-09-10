import "server-only";
import { prisma } from "@/platform/db/prisma";
import { getOrderForHandoff } from "@/integrations/shopify/order-for-handoff";
import { createOrGetOrderDeliveryHandoff } from "./delivery-handoff.service";
import { markWebhookProcessed, markWebhookFailed } from "./webhook-receipt.service";
import { evaluateDeliveryRequestDecision, type DeliveryRequestTrigger, type DeliveryRequestDecision } from "./delivery-request-decision";

// Phase 6F — everything that happens after a webhook delivery has been
// authenticated and claimed, shared by ORDERS_CREATE and ORDERS_PAID
// (build instruction §2/§10). Both topics do exactly the same thing —
// re-read the canonical Order, evaluate the one business decision, persist
// the outcome — and differ only in which trigger they record. Neither
// sends email, writes requested_delivery_date back to Shopify, performs
// any Shopify mutation, or creates a customer-facing Activity.

export type OrderWebhookProcessingResult =
  /** The Order could not be read back — plausibly a read-after-write race;
   * the caller should answer in a way that permits Shopify's retry. */
  | { outcome: "ORDER_NOT_READABLE" }
  /** Evaluated and recorded. `decision.shouldRequest` is false for every
   * real Order today — see delivery-request-decision.ts. */
  | { outcome: "PROCESSED"; decision: DeliveryRequestDecision; createdHandoffId: string | null }
  /** Something transient failed; the receipt is already marked FAILED, so
   * a Shopify redelivery is allowed to reprocess it. */
  | { outcome: "FAILED"; errorCode: string };

/** DeliveryDateHandoff.createdById is a required FK to User and this
 * codebase still has no "system actor" concept, so an automatically
 * created handoff is attributed to the first active ADMIN — the same
 * stand-in every bootstrap/verification script in this engagement has
 * used. Unreachable today (no decision returns shouldRequest: true), and
 * an explicitly open question before it ever becomes reachable: who owns
 * an automatically created handoff? */
async function resolveWebhookCreatedById(): Promise<string | null> {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, select: { id: true } });
  return admin?.id ?? null;
}

export async function processOrderWebhookEvent(input: {
  receiptId: string;
  orderGid: string;
  trigger: DeliveryRequestTrigger;
}): Promise<OrderWebhookProcessingResult> {
  try {
    // Shopify READ only. The webhook payload is a wake-up signal, never
    // the source of truth: the live Order is re-read every time, so a date
    // added between two events (or a cancellation, or a payment completing)
    // is always seen as it is *now*, never as the triggering event
    // described it (build instruction §7/§12).
    const order = await getOrderForHandoff(input.orderGid);
    if (!order) {
      await markWebhookFailed(input.receiptId, "ORDER_NOT_FOUND_ON_REREAD");
      return { outcome: "ORDER_NOT_READABLE" };
    }

    // No trustworthy per-Order classification source exists yet (build
    // instruction §4/§13) — automatic webhook processing always passes
    // UNKNOWN explicitly, never REGULAR_CONSUMER. This is a compile-time
    // requirement now (policy is a required argument), not a convention to
    // remember.
    const decision = evaluateDeliveryRequestDecision({ order, trigger: input.trigger, policy: "UNKNOWN" });

    let createdHandoffId: string | null = null;
    if (decision.shouldRequest) {
      // No live code path produces shouldRequest: true yet — this branch
      // exists so a future positive classification rule does not also
      // require route/handler changes.
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

    // The technical/business outcome is recorded on the webhook receipt
    // itself — no separate workflow table, no customer-facing Activity
    // (build instruction §15/§19). `eligible`/`eligibilityReason` carry
    // shouldRequest/reason; `topic` on the same row already records which
    // event produced it.
    await markWebhookProcessed(input.receiptId, {
      eligible: decision.shouldRequest,
      eligibilityReason: decision.reason,
      createdHandoffId,
    });

    return { outcome: "PROCESSED", decision, createdHandoffId };
  } catch (error) {
    const errorCode = error instanceof Error ? error.name : "UNKNOWN_ERROR";
    await markWebhookFailed(input.receiptId, errorCode);
    return { outcome: "FAILED", errorCode };
  }
}
