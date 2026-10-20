import "server-only";
import { Prisma } from "@/generated/prisma";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { isOnAccountServiceEnabled } from "./config";
import { ON_ACCOUNT_TAG } from "./rules";

// Op rekening v1 — what the existing orders/create and orders/paid webhooks
// do for the payment-due service. Deliberately FAST and Shopify-call free:
// a webhook receipt is processed once (ShopifyWebhookEvent), so anything
// slow or failing here would be lost on Shopify's retry. The webhook only
// records the order; the worker performs every Shopify step with retries.
// The payload is trusted only because the caller already verified the HMAC.

function payloadTags(rawBody: string): string[] {
  try {
    const payload = JSON.parse(rawBody) as { tags?: unknown };
    if (typeof payload.tags !== "string") return [];
    return payload.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

function payloadFinancialStatus(rawBody: string): string | null {
  try {
    const payload = JSON.parse(rawBody) as { financial_status?: unknown };
    return typeof payload.financial_status === "string" ? payload.financial_status : null;
  } catch {
    return null;
  }
}

export type OnAccountWebhookOutcome = "DISABLED" | "NOT_ON_ACCOUNT" | "RECORDED" | "ALREADY_KNOWN" | "MARKED_PAID" | "QUEUED" | "IGNORED";

export async function noteOnAccountFromWebhook(trigger: "ORDER_CREATED" | "ORDER_PAID", orderGid: string, rawBody: string): Promise<OnAccountWebhookOutcome> {
  if (!isOnAccountServiceEnabled()) return "DISABLED";

  if (trigger === "ORDER_CREATED") {
    if (!payloadTags(rawBody).includes(ON_ACCOUNT_TAG)) return "NOT_ON_ACCOUNT";
    try {
      const row = await prisma.onAccountOrder.create({
        data: { shopifyOrderGid: orderGid, sourceApp: "UNKNOWN", state: "REGISTERED" },
      });
      await logAudit({ userId: null, action: "on_account.registered", entityType: "OnAccountOrder", entityId: row.id, metadata: { orderGid, via: "WEBHOOK" } });
      return "RECORDED";
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "ALREADY_KNOWN";
      throw error;
    }
  }

  const row = await prisma.onAccountOrder.findUnique({ where: { shopifyOrderGid: orderGid } });
  if (!row || row.state === "PAID" || row.state === "CANCELLED") return "IGNORED";
  if (payloadFinancialStatus(rawBody) === "paid") {
    const moved = await prisma.onAccountOrder.updateMany({
      where: { id: row.id, state: row.state },
      data: { state: "PAID", paidAt: new Date(), nextAttemptAt: null },
    });
    return moved.count === 1 ? "MARKED_PAID" : "IGNORED";
  }
  // Partially paid etc.: let the worker re-check the order soon.
  await prisma.onAccountOrder.updateMany({ where: { id: row.id, state: row.state }, data: { nextAttemptAt: new Date() } });
  return "QUEUED";
}
