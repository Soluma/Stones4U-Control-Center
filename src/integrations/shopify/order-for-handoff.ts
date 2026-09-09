import "server-only";
import { shopifyGraphQL } from "./client";

// Phase 6B — read-only lookup used when creating an Order-based
// DeliveryDateHandoff (manual staff action today; a future webhook later).
// Deliberately separate from order-mirror.ts's own internal read: that one
// exists purely to support the read-merge-write mutation and fetches only
// what the merge needs (id, cancelledAt, customAttributes). This one
// answers "is this Order a sensible handoff candidate, and what can we
// safely show/store about it" — a different question, with a different,
// slightly broader field set — without ever fetching more than that.
//
// Never queries name/email/phone/address content — only whether a
// shipping address exists at all (a signal explored in Phase 6A discovery,
// not wired into any automatic decision yet — see
// docs/ORDER-DELIVERY-HANDOFF-FOUNDATION.md §"Eligibility"). Customer
// identity stays limited to the GID, same as the Draft Order flow's
// existing, proven customer-matching pattern.

const ORDER_FOR_HANDOFF_QUERY = /* GraphQL */ `
  query OrderForHandoff($id: ID!) {
    order(id: $id) {
      id
      name
      cancelledAt
      displayFulfillmentStatus
      customer {
        id
      }
      shippingAddress {
        city
      }
      customAttributes {
        key
        value
      }
    }
  }
`;

type RawOrderForHandoff = {
  order: {
    id: string;
    name: string;
    cancelledAt: string | null;
    displayFulfillmentStatus: string;
    customer: { id: string } | null;
    shippingAddress: { city: string | null } | null;
    customAttributes: { key: string; value: string }[];
  } | null;
};

export type OrderForHandoffResult = {
  gid: string;
  name: string;
  isCancelled: boolean;
  fulfillmentStatus: string;
  customerGid: string | null;
  hasShippingAddress: boolean;
  hasRequestedDeliveryDateAlready: boolean;
};

/** Read-only. Never called during the public /delivery/[token] flow — only
 * from staff-facing (or, later, webhook-triggered) handoff creation. */
export async function getOrderForHandoff(orderGid: string): Promise<OrderForHandoffResult | null> {
  const data = await shopifyGraphQL<RawOrderForHandoff>(ORDER_FOR_HANDOFF_QUERY, { id: orderGid });
  if (!data.order) return null;

  return {
    gid: data.order.id,
    name: data.order.name,
    isCancelled: !!data.order.cancelledAt,
    fulfillmentStatus: data.order.displayFulfillmentStatus,
    customerGid: data.order.customer?.id ?? null,
    hasShippingAddress: !!data.order.shippingAddress,
    hasRequestedDeliveryDateAlready: data.order.customAttributes.some((a) => a.key === "requested_delivery_date"),
  };
}
