import "server-only";
import { shopifyGraphQL } from "./client";
import { assertShopifyWriteAllowed } from "./write-safety-guard";
import { ShopifyApiError } from "./errors";

// Phase 6B — Order-equivalent of draft-order-mirror.ts. Deliberately its
// own file, not a modification of the Draft version: Draft Orders and
// Orders are different Shopify object types with a different mutation
// shape (orderUpdate takes only `input: OrderInput!`, with the target id
// nested inside that input — draftOrderUpdate takes a separate `id`
// argument; live-verified in Phase 6B.1, see the mutation's own comment
// below) and, per the new Order-based flow, a different caller-side
// contract (no invoiceUrl/payment redirect — see
// delivery-handoff.service.ts's submitRequestedDeliveryDateForOrder()).
// Keeping this separate preserves the same "boundary stays visible and
// easy to review" property the original Draft mirror was built with.

const REQUESTED_DELIVERY_DATE_ATTRIBUTE_KEY = "requested_delivery_date";

// Deliberately minimal: id, cancelledAt, customAttributes only — never the
// nested `customer` object (same reasoning as the Draft mirror: this flow
// never needs customer data, so no extra scope is ever requested for it).
const ORDER_FOR_MIRROR_QUERY = /* GraphQL */ `
  query OrderForMirror($id: ID!) {
    order(id: $id) {
      id
      cancelledAt
      customAttributes {
        key
        value
      }
    }
  }
`;

type RawOrderForMirror = {
  order: {
    id: string;
    cancelledAt: string | null;
    customAttributes: { key: string; value: string }[];
  } | null;
};

// Live-verified against the real Shopify Admin GraphQL schema (Phase
// 6B.1) — orderUpdate's shape differs from draftOrderUpdate's in exactly
// one way that matters here: it takes a single `input: OrderInput!`
// argument, not a separate `id` argument — OrderInput.id carries the
// target Order's GID instead (confirmed via live introspection:
// `orderUpdate(id: ID!, ...)` is rejected with "Field 'orderUpdate'
// doesn't accept argument 'id'"). Do not "correct" this back to the
// draftOrderUpdate shape without re-checking the live schema first.
const ORDER_UPDATE_MUTATION = /* GraphQL */ `
  mutation OrderUpdateRequestedDeliveryDate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type OrderUpdateResponse = {
  orderUpdate: {
    order: { id: string } | null;
    userErrors: { field: string[] | null; message: string }[];
  };
};

export type OrderMirrorResult = { orderGid: string };

/**
 * Read-merge-write: sets exactly one customAttribute
 * (`requested_delivery_date`) on the given Order, preserving every other
 * existing attribute untouched, never duplicating the key. Mirrors
 * mirrorRequestedDeliveryDateToShopify()'s exact contract for Draft
 * Orders — see that function's doc comment for the shared reasoning.
 *
 * Calls assertShopifyWriteAllowed() first, every time, no exceptions
 * (CLAUDE.md). Refuses to mutate a cancelled Order — cancellation is
 * checked as part of the same read used for the merge, so a stale/
 * cancelled-in-the-meantime Order never gets a pointless or misleading
 * write (docs/ORDER-DELIVERY-HANDOFF-FOUNDATION.md §"Cancelled Order
 * safety").
 */
export async function mirrorRequestedDeliveryDateToOrder(orderGid: string, dateIso: string): Promise<OrderMirrorResult> {
  await assertShopifyWriteAllowed();

  const current = await shopifyGraphQL<RawOrderForMirror>(ORDER_FOR_MIRROR_QUERY, { id: orderGid });
  if (!current.order) {
    throw new ShopifyApiError(`Order ${orderGid} bestaat niet (meer) in Shopify.`);
  }
  if (current.order.cancelledAt) {
    throw new ShopifyApiError(`Order ${orderGid} is geannuleerd — geen leverdatum-mirror mogelijk.`);
  }

  const merged = current.order.customAttributes.filter((a) => a.key !== REQUESTED_DELIVERY_DATE_ATTRIBUTE_KEY);
  merged.push({ key: REQUESTED_DELIVERY_DATE_ATTRIBUTE_KEY, value: dateIso });

  const result = await shopifyGraphQL<OrderUpdateResponse>(ORDER_UPDATE_MUTATION, {
    input: { id: orderGid, customAttributes: merged },
  });

  const errors = result.orderUpdate.userErrors;
  if (errors.length > 0) {
    throw new ShopifyApiError(`Shopify orderUpdate gaf userErrors terug.`, { graphqlErrors: errors });
  }

  return { orderGid };
}
