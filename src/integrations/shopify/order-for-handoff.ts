import "server-only";
import { shopifyGraphQL } from "./client";
import { aggregateFulfillmentMode, type FulfillmentMode } from "./fulfillment-mode";
import {
  readExplicitFulfillmentMode,
  resolveFulfillmentMode,
  type ExplicitFulfillmentMode,
  type FulfillmentModeResolution,
} from "./fulfillment-contract";
import { readCustomerClassification } from "./customer-classification-read";
import type { CustomerClassification } from "./customer-classification";

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
      fullyPaid
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
      fulfillmentOrders(first: 50) {
        pageInfo {
          hasNextPage
        }
        edges {
          node {
            deliveryMethod {
              methodType
            }
          }
        }
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
    fullyPaid: boolean;
    customer: { id: string } | null;
    shippingAddress: { city: string | null } | null;
    customAttributes: { key: string; value: string }[];
    fulfillmentOrders: {
      pageInfo: { hasNextPage: boolean };
      edges: { node: { deliveryMethod: { methodType: string } | null } }[];
    };
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
  // Phase 6E — the actual ISO date value when present, additive alongside
  // the existing boolean above (never removed/renamed — eligibility.ts and
  // the webhook route already depend on hasRequestedDeliveryDateAlready
  // exactly as it is, and 6E must not touch that committed, working code
  // — see build instruction §18). Needed for the staff "existing date"
  // confirmation flow, which must show staff *which* date Shopify already
  // has, not just that one exists. Deliberately carries no assumption
  // about *where* this value came from (quote, Draft, staff, customer
  // portal) — see delivery-handoff.service.ts's own doc comment on
  // createOrderDeliveryHandoffForStaff() for the full provenance-neutral
  // reasoning.
  requestedDeliveryDate: string | null;
  // Phase 6F — the canonical, current payment state, read live from
  // Shopify rather than inferred from which webhook woke us up (a webhook
  // is only a wake-up signal; the Order read is the source of truth —
  // build instruction §7). Deliberately the single `fullyPaid` boolean and
  // nothing else: no amounts, no gateway names, no payment-method or
  // financial detail is fetched or stored, because the only question this
  // feature ever needs answered is "is the regular-customer payment
  // condition currently satisfied?".
  fullyPaid: boolean;
  // Phase 6H, renamed in 6K — LAYER 1: Shopify's own semantics, nothing
  // more. Derived from every FulfillmentOrder's deliveryMethod.methodType,
  // aggregated conservatively: a mixed or truncated set reads as `UNKNOWN`
  // rather than picking a winner (see aggregateFulfillmentMode()). `UNKNOWN`
  // also when there is no FulfillmentOrder yet or it has no deliveryMethod.
  //
  // Exposed for observability and correlation only. It is NOT the
  // authoritative answer to "is Stones4U delivering this Order" — Phase 6I
  // proved native DELIVERY is frequently wrong about that. Read
  // `fulfillmentResolution` instead.
  nativeFulfillmentMode: FulfillmentMode;
  // Phase 6K — LAYER 2 inputs and result.
  //
  // The explicit Stones4U-owned signal as stated on the Order, or null when
  // absent, invalid, or duplicated (the resolution's `diagnostic` says
  // which). Exposed separately so migration progress can be measured without
  // re-reading raw attributes.
  explicitFulfillmentMode: ExplicitFulfillmentMode | null;
  // The authoritative resolution — the field callers should actually use.
  // Callers must never re-derive authority from the two signals above; that
  // is exactly what this field exists to prevent (build instruction §8).
  // Phase 6W — now genuinely wired into evaluateDeliveryRequestDecision():
  // only a resolved DELIVERY may pass the fulfillment gate.
  fulfillmentResolution: FulfillmentModeResolution;
  // Phase 6W — the attached Shopify Customer's classification, read live
  // from that customer's own metafields rather than duplicated onto the
  // Order (see customer-classification.ts for why the Customer is the source
  // of truth). Always present: an Order without a customer, or a
  // classification that could not be read, yields the fail-closed UNKNOWN
  // result rather than null, so no caller has to remember to handle absence.
  customerClassification: CustomerClassification;
};

/** Read-only. Never called during the public /delivery/[token] flow — only
 * from staff-facing (or, later, webhook-triggered) handoff creation. */
export async function getOrderForHandoff(orderGid: string): Promise<OrderForHandoffResult | null> {
  const data = await shopifyGraphQL<RawOrderForHandoff>(ORDER_FOR_HANDOFF_QUERY, { id: orderGid });
  if (!data.order) return null;

  // Deliberately unchanged from Phase 6E: first match wins for the date.
  // The asymmetry with the stricter duplicate handling of the fulfillment
  // mode below is intentional — a duplicated date can only ever *suppress* a
  // request (safe direction, whichever value is picked), whereas a duplicated
  // mode could *enable* customer contact, so only the latter has to fail
  // closed. See docs/ORDER-DELIVERY-HANDOFF-FOUNDATION.md §"Duplicate keys".
  const requestedDeliveryDateAttribute = data.order.customAttributes.find((a) => a.key === "requested_delivery_date");
  const fulfillmentOrders = data.order.fulfillmentOrders;

  const explicit = readExplicitFulfillmentMode(data.order.customAttributes);
  const nativeFulfillmentMode = aggregateFulfillmentMode({
    methodTypes: fulfillmentOrders.edges.map((edge) => edge.node.deliveryMethod?.methodType ?? null),
    hasUnreadFulfillmentOrders: fulfillmentOrders.pageInfo.hasNextPage,
  });

  // A second, deliberately independent read (see readCustomerClassification()
  // for why it may not be folded into the query above): it never throws, so a
  // classification problem can only ever produce UNKNOWN — it can never stop
  // an Order from being read.
  const customerClassification = await readCustomerClassification(data.order.customer?.id ?? null);

  return {
    gid: data.order.id,
    name: data.order.name,
    isCancelled: !!data.order.cancelledAt,
    fulfillmentStatus: data.order.displayFulfillmentStatus,
    customerGid: data.order.customer?.id ?? null,
    hasShippingAddress: !!data.order.shippingAddress,
    hasRequestedDeliveryDateAlready: requestedDeliveryDateAttribute !== undefined,
    requestedDeliveryDate: requestedDeliveryDateAttribute?.value ?? null,
    fullyPaid: data.order.fullyPaid,
    nativeFulfillmentMode,
    explicitFulfillmentMode: explicit.status === "VALID" ? explicit.mode : null,
    fulfillmentResolution: resolveFulfillmentMode({ explicit, native: nativeFulfillmentMode }),
    customerClassification,
  };
}
