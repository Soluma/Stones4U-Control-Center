import "server-only";
import { prisma } from "@/platform/db/prisma";
import { Prisma } from "@/generated/prisma";
import type { ShopifyWebhookEvent } from "@/generated/prisma";

// Phase 6C — durable idempotency for Shopify webhook deliveries, keyed on
// (shopDomain, webhookId) per Shopify's own guidance (X-Shopify-Webhook-Id
// is "a unique composite key for each delivery that you use to identify
// and deduplicate individual deliveries"). Deliberately separate from
// DeliveryDateHandoff's own uniqueness — see the ShopifyWebhookEvent model
// comment in schema.prisma for why both exist.

export type WebhookClaim =
  | { action: "process"; receipt: ShopifyWebhookEvent }
  | { action: "retry"; receipt: ShopifyWebhookEvent }
  | { action: "skip"; receipt: ShopifyWebhookEvent };

// There's no heartbeat/lease column on this table — receivedAt is the only
// signal available for telling "another request is actively processing
// this right now" apart from "a prior attempt crashed and this row is
// abandoned." A RECEIVED row younger than this window is presumed still
// in flight (the actual processing here is a single GraphQL read plus
// local eligibility logic, normally sub-second); older than this is
// presumed abandoned and safe to take over. This is a heuristic, not a
// guarantee — but it closes the common real-world race (near-simultaneous
// duplicate delivery) without needing a new migration, while still letting
// a genuinely crashed delivery recover well within Shopify's own retry
// window (up to 8 attempts over 4 hours).
const IN_FLIGHT_LEASE_MS = 30_000;

function isLikelyStillInFlight(receipt: ShopifyWebhookEvent): boolean {
  return receipt.status === "RECEIVED" && Date.now() - receipt.receivedAt.getTime() < IN_FLIGHT_LEASE_MS;
}

/**
 * Claims a webhook delivery for processing, or reports that it's already
 * been handled (or previously failed and may be retried). Never called
 * before HMAC + shop-identity + topic verification all succeed — a
 * request that fails any of those checks is rejected before it ever
 * reaches this function, and is never persisted at all (nothing to
 * dedupe against an unverified sender).
 *
 * - PROCESSED already → `skip`: business logic must not run again.
 * - RECEIVED and still within the in-flight lease window → `skip`: another
 *   request is presumed to be actively processing this same delivery right
 *   now (Shopify's at-least-once delivery can send the same webhookId more
 *   than once at the transport level, not only as an application-level
 *   retry) — this request must not also run business logic concurrently.
 * - FAILED, or RECEIVED past the lease window (crash mid-processing, never
 *   reached a terminal status) → `retry`: the same row is reused, never a
 *   second row for the same (shopDomain, webhookId) — this is what makes a
 *   transient failure retryable rather than a permanent poison record.
 * - Not found → `process`: a fresh RECEIVED row is created.
 *
 * Concurrency note: the find-then-create sequence below is not itself
 * atomic — two truly simultaneous deliveries of the same (shopDomain,
 * webhookId) can both observe "not found" before either commits. The DB's
 * own unique index on (shopDomain, webhookId) is what actually closes that
 * narrower race: the losing `create` fails with P2002, which is caught
 * here and treated as "someone else just claimed this," re-fetching and
 * running the winner's row through the same in-flight/retry/skip logic as
 * the ordinary found-existing path above — never letting the violation
 * propagate as an unhandled processing failure.
 */
export async function claimWebhookDelivery(shopDomain: string, webhookId: string, topic: string): Promise<WebhookClaim> {
  const existing = await prisma.shopifyWebhookEvent.findUnique({
    where: { shopDomain_webhookId: { shopDomain, webhookId } },
  });

  if (existing) {
    if (existing.status === "PROCESSED" || isLikelyStillInFlight(existing)) {
      return { action: "skip", receipt: existing };
    }
    return { action: "retry", receipt: existing };
  }

  try {
    const receipt = await prisma.shopifyWebhookEvent.create({
      data: { shopDomain, webhookId, topic, status: "RECEIVED" },
    });
    return { action: "process", receipt };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await prisma.shopifyWebhookEvent.findUniqueOrThrow({
        where: { shopDomain_webhookId: { shopDomain, webhookId } },
      });
      if (winner.status === "PROCESSED" || isLikelyStillInFlight(winner)) {
        return { action: "skip", receipt: winner };
      }
      return { action: "retry", receipt: winner };
    }
    throw error;
  }
}

export async function markWebhookProcessed(
  receiptId: string,
  outcome: { eligible: boolean; eligibilityReason: string; createdHandoffId: string | null },
): Promise<void> {
  await prisma.shopifyWebhookEvent.update({
    where: { id: receiptId },
    data: {
      status: "PROCESSED",
      processedAt: new Date(),
      eligible: outcome.eligible,
      eligibilityReason: outcome.eligibilityReason,
      createdHandoffId: outcome.createdHandoffId,
      errorSummary: null,
    },
  });
}

export async function markWebhookFailed(receiptId: string, errorSummary: string): Promise<void> {
  await prisma.shopifyWebhookEvent.update({
    where: { id: receiptId },
    data: { status: "FAILED", errorSummary },
  });
}
