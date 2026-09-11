import "server-only";
import { prisma } from "@/platform/db/prisma";
import { getOrderForHandoff, type OrderForHandoffResult } from "@/integrations/shopify/order-for-handoff";
import type { FulfillmentMode } from "@/integrations/shopify/fulfillment-mode";
import {
  deliveryPolicyForPaymentPolicy,
  evaluateDeliveryRequestDecision,
  type DeliveryRequestDecision,
  type DeliveryRequestTrigger,
} from "./delivery-request-decision";
import { createOrGetOrderDeliveryHandoff, resolveCustomerProfileIdForShopifyGid } from "./delivery-handoff.service";
import type { DeliveryDateHandoff } from "@/generated/prisma";

// Phase 6AI — the ONE canonical path from "a Shopify Order exists" to "a
// customer has been asked for a fulfillment date".
//
// Everything that ever asks that question goes through here: the staff button
// today, and the webhook automation later. There is deliberately no separate
// "test" implementation — a manual trigger that took a different route would
// prove nothing about what automation will eventually do.
//
// It creates a handoff and nothing else. No email, no notification, no webhook
// registration — those do not exist anywhere in this codebase, and this phase
// did not add them.

/** Modes for which a customer can be asked a fulfillment date. Mirrors the
 * decision engine's own eligibility, which since 6AH includes pickup: staff
 * must collect and prepare the goods before a customer arrives. */
const CUSTOMER_FACING_MODES: ReadonlySet<FulfillmentMode> = new Set<FulfillmentMode>([
  "DELIVERY",
  "CUSTOMER_PICKUP",
]);

/** The resolved mode, narrowed to the two the customer flow can render. */
export type CustomerFacingFulfillmentMode = "DELIVERY" | "CUSTOMER_PICKUP";

export function isCustomerFacingMode(mode: FulfillmentMode): mode is CustomerFacingFulfillmentMode {
  return CUSTOMER_FACING_MODES.has(mode);
}

export type OrderDeliveryRequestEvaluation = {
  order: OrderForHandoffResult;
  decision: DeliveryRequestDecision;
  /** The resolved mode, or null when it is not one the customer flow supports. */
  customerFacingMode: CustomerFacingFulfillmentMode | null;
};

/**
 * Read-only: what would happen for this Order, and why.
 *
 * Runs exactly the production decision path — canonical Order re-read,
 * customer classification, fulfillment resolution, decision — and returns the
 * result without acting on it. Safe to call from staff UI to explain an
 * ineligible Order.
 */
export async function evaluateOrderDeliveryRequest(
  orderGid: string,
  trigger: DeliveryRequestTrigger = "STAFF_REVIEW",
): Promise<OrderDeliveryRequestEvaluation | null> {
  const order = await getOrderForHandoff(orderGid);
  if (!order) return null;

  const policy = deliveryPolicyForPaymentPolicy(order.customerClassification.paymentPolicy);
  const decision = evaluateDeliveryRequestDecision({ order, trigger, policy });
  const mode = order.fulfillmentResolution.mode;

  return {
    order,
    decision,
    customerFacingMode: isCustomerFacingMode(mode) ? mode : null,
  };
}

/**
 * The mode to render/accept for an Order handoff, re-resolved live, or null
 * when the customer flow no longer applies.
 *
 * Used by both the public page and the submit route. It deliberately does NOT
 * consult the stored `fulfillmentMode` snapshot: an Order can be cancelled or
 * reclassified between the request being sent and the customer acting on it,
 * and in that window the truth is on the Order, not on our row.
 *
 * Returns null — never throws — for a cancelled Order, a non-customer-facing
 * mode, or an Order that cannot be read. The caller renders a safe
 * "no longer applicable" state rather than a form that would fail on submit.
 */
export async function resolveCustomerFacingModeForHandoff(handoff: {
  shopifyOrderGid: string | null;
}): Promise<CustomerFacingFulfillmentMode | null> {
  if (!handoff.shopifyOrderGid) return null;

  let order: OrderForHandoffResult | null;
  try {
    order = await getOrderForHandoff(handoff.shopifyOrderGid);
  } catch (error) {
    console.error(
      "delivery_handoff_mode_resolution_failed",
      error instanceof Error ? error.name : "UNKNOWN_ERROR",
    );
    return null;
  }
  if (!order || order.isCancelled) return null;

  const mode = order.fulfillmentResolution.mode;
  return isCustomerFacingMode(mode) ? mode : null;
}

export type CreateOrderDeliveryRequestResult =
  /** A new handoff was created for an eligible Order. */
  | { outcome: "CREATED"; handoff: DeliveryDateHandoff; rawToken: string | null; evaluation: OrderDeliveryRequestEvaluation }
  /** An active handoff already existed; it is returned unchanged. */
  | { outcome: "REUSED"; handoff: DeliveryDateHandoff; rawToken: string | null; evaluation: OrderDeliveryRequestEvaluation }
  /** The Order is not eligible. `evaluation.decision.reason` says why. */
  | { outcome: "NOT_ELIGIBLE"; evaluation: OrderDeliveryRequestEvaluation }
  /** The Order could not be read back from Shopify at all. */
  | { outcome: "ORDER_NOT_READABLE" };

/**
 * Creates a customer fulfillment-date request for an Order, but only if the
 * decision engine says it is warranted.
 *
 * **Idempotent.** Two things guarantee that, at different levels:
 *
 *  1. `createOrGetOrderDeliveryHandoff()` is itself get-or-create on the
 *     `(sourceSystem, externalId)` unique constraint, so a second call cannot
 *     produce a second row even under a race.
 *  2. An Order that already carries a `requested_delivery_date` is rejected by
 *     the decision engine before we get there (`ALREADY_HAS_REQUESTED_DELIVERY_DATE`),
 *     so a completed request is never re-asked.
 *
 * The existing-handoff check runs BEFORE eligibility on purpose: once a
 * request has been sent, the customer's link must keep working even if the
 * Order drifts out of eligibility afterwards (a later payment reversal, say).
 * Reusing is not the same as creating, and only creating needs eligibility.
 */
export async function createOrderDeliveryDateHandoffIfEligible(input: {
  orderGid: string;
  createdById: string;
  trigger?: DeliveryRequestTrigger;
}): Promise<CreateOrderDeliveryRequestResult> {
  const evaluation = await evaluateOrderDeliveryRequest(input.orderGid, input.trigger ?? "STAFF_REVIEW");
  if (!evaluation) return { outcome: "ORDER_NOT_READABLE" };

  const existing = await prisma.deliveryDateHandoff.findUnique({
    where: { sourceSystem_externalId: { sourceSystem: "SHOPIFY", externalId: evaluation.order.gid } },
  });
  if (existing) {
    // Deliberately no new token: staff opening this screen must never
    // invalidate a link the customer may already be holding (§13).
    return { outcome: "REUSED", handoff: existing, rawToken: null, evaluation };
  }

  if (!evaluation.decision.shouldRequest) {
    return { outcome: "NOT_ELIGIBLE", evaluation };
  }

  const customerProfileId = await resolveCustomerProfileIdForShopifyGid(evaluation.order.customerGid);
  const { handoff, rawToken } = await createOrGetOrderDeliveryHandoff({
    shopifyOrderGid: evaluation.order.gid,
    publicReference: evaluation.order.name,
    customerProfileId,
    createdById: input.createdById,
    // Snapshot only — the public page re-resolves this live before rendering.
    fulfillmentMode: evaluation.customerFacingMode,
  });

  return { outcome: "CREATED", handoff, rawToken, evaluation };
}
