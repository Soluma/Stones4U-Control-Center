import "server-only";
import { prisma } from "@/platform/db/prisma";
import { getEarliestRequestedDeliveryDate } from "./delivery-lead-time";
import {
  evaluateOrderDeliveryRequest,
  type CustomerFacingFulfillmentMode,
} from "./order-delivery-request.service";
import {
  createOrGetOrderDeliveryHandoff,
  resolveCustomerProfileIdForShopifyGid,
  submitRequestedDeliveryDateForOrder,
} from "./delivery-handoff.service";
import { DeliveryHandoffError } from "./errors";

// Phase 6AJ — the Shopify Order Status page as a trigger into the SAME
// fulfillment-date flow the staff button already uses.
//
// This module is deliberately thin. It owns exactly two things that are
// genuinely new:
//
//   1. binding a Shopify-signed customer identity to an Order, and
//   2. shaping the answer for a UI that renders outside our control.
//
// Everything else — classification, fulfillment-mode resolution, payment
// eligibility, the Europe/Amsterdam two-business-day rule, weekend rejection,
// PRESERVE-vs-SET patch semantics, the Shopify write, the Activity row and the
// audit entry — is the 6AI path, called, not reimplemented. If a rule needs to
// change it changes in one place and both surfaces move together.
//
// SECURITY POSTURE. Nothing the browser sends is trusted as authority:
//
//   * the Order GID arrives in the request body, so it is treated as a
//     *lookup key*, never as proof of access;
//   * the customer identity comes only from the verified `sub` claim of a
//     Shopify-signed session token, never from the body;
//   * the binding is re-checked against a fresh Admin read on every call,
//     including the submit, so an Order that changes hands or is cancelled
//     between render and submit is rejected at the moment of the write;
//   * an Order with no customer (a guest checkout) can never be bound and
//     therefore can never be written to from here. That is a deliberate
//     fail-closed gap, not an oversight — see ORDER_HAS_NO_CUSTOMER.

/** Why a customer cannot (or need not) act on this Order right now. All of
 * these render as a neutral, non-editable state in the extension. */
export type OrderStatusUnavailableReason =
  /** The Order could not be read from Shopify at all. */
  | "ORDER_NOT_READABLE"
  /** The signed customer is not the customer on this Order. */
  | "NOT_YOUR_ORDER"
  /** Guest checkout: no customer on the Order to bind a signed identity to. */
  | "ORDER_HAS_NO_CUSTOMER"
  /** Cancelled, NONE/RETAIL/PICKUP_POINT, unpaid, unclassified, … */
  | "NOT_ELIGIBLE";

export type OrderStatusFulfillmentState =
  /** Show nothing editable. */
  | { status: "UNAVAILABLE"; reason: OrderStatusUnavailableReason }
  /** A date is already known — show it instead of asking again. */
  | {
      status: "ALREADY_SUBMITTED";
      mode: CustomerFacingFulfillmentMode | null;
      requestedDeliveryDate: string;
      deliveryComment: string | null;
      largeTruckAccessConfirmed: boolean | null;
    }
  /** Ask the question. */
  | {
      status: "CAN_SUBMIT";
      mode: CustomerFacingFulfillmentMode;
      /** Earliest date the server will accept, for the field's `min`. The
       * server re-validates regardless; this is a UX hint only. */
      earliestDate: string;
    };

/**
 * Resolves an Order for a signed-in customer, or explains why it cannot be.
 *
 * The returned evaluation is the real 6AI evaluation — same decision engine,
 * same Order read — so callers never form a second opinion about eligibility.
 */
async function resolveBoundOrder(input: { orderGid: string; customerGid: string }) {
  const evaluation = await evaluateOrderDeliveryRequest(input.orderGid, "STAFF_REVIEW");
  if (!evaluation) return { ok: false as const, reason: "ORDER_NOT_READABLE" as const };

  // A guest Order has no customer to bind to. Refusing is the only safe
  // answer: there is no signed identity that could ever prove ownership.
  if (!evaluation.order.customerGid) {
    return { ok: false as const, reason: "ORDER_HAS_NO_CUSTOMER" as const };
  }

  // The one authorization check. Deliberately an exact comparison of two
  // GIDs, one of which came out of a verified signature and the other out of
  // a live Admin read. Nothing from the request body participates.
  if (evaluation.order.customerGid !== input.customerGid) {
    return { ok: false as const, reason: "NOT_YOUR_ORDER" as const };
  }

  return { ok: true as const, evaluation };
}

/**
 * Read-only: what the Order Status block should render for this customer.
 *
 * Never throws for an ordinary "no" — an unreadable Order, someone else's
 * Order and an ineligible Order all return an UNAVAILABLE state, because the
 * extension must render something calm in every one of those cases.
 */
export async function readOrderStatusFulfillmentState(input: {
  orderGid: string;
  customerGid: string;
  now?: Date;
}): Promise<OrderStatusFulfillmentState> {
  let bound: Awaited<ReturnType<typeof resolveBoundOrder>>;
  try {
    bound = await resolveBoundOrder(input);
  } catch (error) {
    console.error(
      "order_status_extension_read_failed",
      error instanceof Error ? error.name : "UNKNOWN_ERROR",
    );
    return { status: "UNAVAILABLE", reason: "ORDER_NOT_READABLE" };
  }

  if (!bound.ok) {
    return { status: "UNAVAILABLE", reason: bound.reason };
  }

  const { evaluation } = bound;

  // A date already on the Order wins over everything else: the customer has
  // answered, so show the answer rather than the question. The Order is the
  // source of truth for the date; our own row only adds the two logistics
  // fields, which live nowhere else.
  if (evaluation.order.hasRequestedDeliveryDateAlready && evaluation.order.requestedDeliveryDate) {
    const handoff = await prisma.deliveryDateHandoff.findUnique({
      where: { sourceSystem_externalId: { sourceSystem: "SHOPIFY", externalId: evaluation.order.gid } },
      select: { deliveryComment: true, largeTruckAccessConfirmed: true },
    });
    return {
      status: "ALREADY_SUBMITTED",
      mode: evaluation.customerFacingMode,
      requestedDeliveryDate: evaluation.order.requestedDeliveryDate,
      deliveryComment: handoff?.deliveryComment ?? null,
      largeTruckAccessConfirmed: handoff?.largeTruckAccessConfirmed ?? null,
    };
  }

  if (!evaluation.decision.shouldRequest || !evaluation.customerFacingMode) {
    return { status: "UNAVAILABLE", reason: "NOT_ELIGIBLE" };
  }

  return {
    status: "CAN_SUBMIT",
    mode: evaluation.customerFacingMode,
    earliestDate: getEarliestRequestedDeliveryDate({
      orderCreatedAt: new Date(),
      now: input.now ?? new Date(),
    }),
  };
}

export type OrderStatusSubmitResult =
  | {
      ok: true;
      mode: CustomerFacingFulfillmentMode;
      requestedDeliveryDate: string;
      largeTruckAccessConfirmed: boolean | null;
    }
  | { ok: false; kind: "UNAVAILABLE"; reason: OrderStatusUnavailableReason }
  /** The date itself was rejected — message is customer-facing Dutch. */
  | { ok: false; kind: "INVALID"; message: string };

/**
 * Accepts a fulfillment date from the Order Status page.
 *
 * Re-runs the full binding and eligibility check first: the render happened at
 * some earlier moment, and this is the moment a Shopify write would actually
 * occur. A handoff row is created on demand if none exists, so the customer
 * answering directly produces exactly the same record — and the same Activity
 * and audit trail — as answering via a staff-sent link.
 */
export async function submitOrderStatusFulfillmentDate(input: {
  orderGid: string;
  customerGid: string;
  requestedDeliveryDate: string | null | undefined;
  deliveryComment?: string | null;
  largeTruckAccessConfirmed?: unknown;
}): Promise<OrderStatusSubmitResult> {
  const bound = await resolveBoundOrder(input);
  if (!bound.ok) {
    return { ok: false, kind: "UNAVAILABLE", reason: bound.reason };
  }

  const { evaluation } = bound;
  const mode = evaluation.customerFacingMode;

  // Eligibility is re-asserted at write time, not inherited from the render.
  // An Order that already has a date is not re-writable from here: the
  // decision engine rejects it with ALREADY_HAS_REQUESTED_DELIVERY_DATE, and
  // changing an agreed date is a staff conversation, not a self-service one.
  if (!evaluation.decision.shouldRequest || !mode) {
    return { ok: false, kind: "UNAVAILABLE", reason: "NOT_ELIGIBLE" };
  }

  const customerProfileId = await resolveCustomerProfileIdForShopifyGid(evaluation.order.customerGid);
  const { handoff } = await createOrGetOrderDeliveryHandoff({
    shopifyOrderGid: evaluation.order.gid,
    publicReference: evaluation.order.name,
    customerProfileId,
    // The customer answered on Shopify's own page; there is no staff creator.
    createdById: null,
    fulfillmentMode: mode,
  });

  try {
    const result = await submitRequestedDeliveryDateForOrder(handoff, {
      rawDateInput: input.requestedDeliveryDate,
      deliveryComment: input.deliveryComment,
      // A pickup never carries a truck answer. The question is not asked for
      // pickup, so a crafted request supplying one is dropped rather than
      // written — identical to the public page's submit route.
      largeTruckAccessConfirmed:
        mode === "DELIVERY" ? input.largeTruckAccessConfirmed : undefined,
    });
    return {
      ok: true,
      mode,
      requestedDeliveryDate: result.requestedDeliveryDate,
      largeTruckAccessConfirmed: result.largeTruckAccessConfirmed,
    };
  } catch (error) {
    if (error instanceof DeliveryHandoffError) {
      return { ok: false, kind: "INVALID", message: error.message };
    }
    throw error;
  }
}
