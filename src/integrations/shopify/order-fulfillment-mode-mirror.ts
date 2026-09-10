import "server-only";
import { shopifyGraphQL } from "./client";
import { assertShopifyWriteAllowed } from "./write-safety-guard";
import { ShopifyApiError, OrderCancelledError } from "./errors";
import {
  STONES4U_FULFILLMENT_MODE_ATTRIBUTE_KEY,
  readExplicitFulfillmentMode,
  type ExplicitFulfillmentMode,
  type ExplicitFulfillmentModeRead,
} from "./fulfillment-contract";

// Phase 6L — the only writer of the Stones4U fulfillment contract.
// Deliberately its own file rather than an addition to order-mirror.ts:
// that one exists solely to mirror `requested_delivery_date` and its whole
// contract (including its caller-side semantics) is about a customer's date
// answer. This one writes a staff classification. They share the read-merge-
// write technique, not a purpose.
//
// `orderUpdate` REPLACES the entire customAttributes array, so read-merge-
// write is mandatory — anything not carried across is silently destroyed.
// `requested_delivery_date` in particular must survive every operation here
// (build instruction §18).

const ORDER_FOR_MODE_WRITE_QUERY = /* GraphQL */ `
  query OrderForFulfillmentModeWrite($id: ID!) {
    order(id: $id) {
      id
      name
      cancelledAt
      customAttributes {
        key
        value
      }
    }
  }
`;

type RawOrderForModeWrite = {
  order: {
    id: string;
    name: string;
    cancelledAt: string | null;
    customAttributes: { key: string; value: string }[];
  } | null;
};

// Asks for customAttributes back so the write can be verified from the
// mutation's own response (build instruction §14) without a further query.
const ORDER_UPDATE_MUTATION = /* GraphQL */ `
  mutation OrderUpdateFulfillmentMode($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
        customAttributes {
          key
          value
        }
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
    order: { id: string; customAttributes: { key: string; value: string }[] } | null;
    userErrors: { field: string[] | null; message: string }[];
  };
};

export type FulfillmentModeWriteResult = {
  orderGid: string;
  orderName: string;
  /** False when the Order was already in exactly the requested state and no
   * mutation was sent at all (build instruction §9). */
  written: boolean;
  /** The contract state as it was immediately before this write — read by
   * the server, never supplied by a caller. */
  previous: ExplicitFulfillmentModeRead;
  /** How many stray copies of the canonical key this write removed. Non-zero
   * only for a duplicate repair (build instruction §17). */
  duplicatesRemoved: number;
};

/**
 * Sets (`mode`) or clears (`null`) the explicit fulfillment mode on one
 * Order, preserving every unrelated customAttribute exactly.
 *
 * Safety chain, in order, every time, no exceptions:
 * 1. `assertShopifyWriteAllowed()` — shop-identity allowlist, before any
 *    Order is even read.
 * 2. canonical server-side re-read of the Order.
 * 3. cancelled-Order refusal (`OrderCancelledError`) — checked from that same
 *    read, so an Order cancelled in the meantime can never be written.
 * 4. read-merge-write over the current customAttributes.
 * 5. post-write verification of the mutation's own returned attributes.
 *
 * Only a canonical `ExplicitFulfillmentMode` is ever written — never
 * `UNKNOWN`, never a lower-cased or Dutch label (build instruction §8). The
 * read-side normalization in fulfillment-contract.ts is deliberately not
 * mirrored here: reads are forgiving, writes are exact.
 *
 * Every copy of the canonical key is dropped during the merge and at most one
 * is written back, so a duplicated key is repaired rather than perpetuated —
 * but only as part of a deliberate write, never as a side effect of reading.
 */
export async function writeOrderFulfillmentMode(
  orderGid: string,
  mode: ExplicitFulfillmentMode | null,
): Promise<FulfillmentModeWriteResult> {
  await assertShopifyWriteAllowed();

  const current = await shopifyGraphQL<RawOrderForModeWrite>(ORDER_FOR_MODE_WRITE_QUERY, { id: orderGid });
  if (!current.order) {
    throw new ShopifyApiError(`Order ${orderGid} bestaat niet (meer) in Shopify.`);
  }
  if (current.order.cancelledAt) {
    throw new OrderCancelledError(orderGid);
  }

  const attributes = current.order.customAttributes;
  const existing = attributes.filter((a) => a.key === STONES4U_FULFILLMENT_MODE_ATTRIBUTE_KEY);
  const previous = readExplicitFulfillmentMode(attributes);

  // Idempotence (build instruction §9): already in exactly the requested
  // state, so no mutation is sent and the caller records no change. "Exactly"
  // means one key holding the canonical spelling — a single key holding
  // " delivery" still gets rewritten, because the stored value should be
  // canonical even though the reader would have tolerated it.
  const alreadyExact =
    mode === null ? existing.length === 0 : existing.length === 1 && existing[0]?.value === mode;
  if (alreadyExact) {
    return {
      orderGid: current.order.id,
      orderName: current.order.name,
      written: false,
      previous,
      duplicatesRemoved: 0,
    };
  }

  const merged = attributes.filter((a) => a.key !== STONES4U_FULFILLMENT_MODE_ATTRIBUTE_KEY);
  const preservedBefore = merged.map((a) => JSON.stringify([a.key, a.value])).sort();
  if (mode !== null) {
    merged.push({ key: STONES4U_FULFILLMENT_MODE_ATTRIBUTE_KEY, value: mode });
  }

  const result = await shopifyGraphQL<OrderUpdateResponse>(ORDER_UPDATE_MUTATION, {
    input: { id: orderGid, customAttributes: merged },
  });

  const errors = result.orderUpdate.userErrors;
  if (errors.length > 0) {
    throw new ShopifyApiError(`Shopify orderUpdate gaf userErrors terug.`, { graphqlErrors: errors });
  }
  const written = result.orderUpdate.order;
  if (!written) {
    throw new ShopifyApiError(`Shopify orderUpdate gaf geen Order terug voor ${orderGid}.`);
  }

  // Post-write verification (build instruction §14) — never report success
  // on the strength of an absent userErrors array alone.
  const writtenModeAttributes = written.customAttributes.filter(
    (a) => a.key === STONES4U_FULFILLMENT_MODE_ATTRIBUTE_KEY,
  );
  const expectedCount = mode === null ? 0 : 1;
  if (writtenModeAttributes.length !== expectedCount) {
    throw new ShopifyApiError(
      `Verificatie na schrijven mislukt: ${writtenModeAttributes.length} keer ${STONES4U_FULFILLMENT_MODE_ATTRIBUTE_KEY} op ${orderGid}, verwacht ${expectedCount}.`,
    );
  }
  if (mode !== null && writtenModeAttributes[0]?.value !== mode) {
    throw new ShopifyApiError(`Verificatie na schrijven mislukt: onverwachte waarde op ${orderGid}.`);
  }

  // Every unrelated attribute — `requested_delivery_date` above all — must
  // have survived byte-for-byte.
  const preservedAfter = written.customAttributes
    .filter((a) => a.key !== STONES4U_FULFILLMENT_MODE_ATTRIBUTE_KEY)
    .map((a) => JSON.stringify([a.key, a.value]))
    .sort();
  if (preservedAfter.length !== preservedBefore.length || preservedAfter.some((v, i) => v !== preservedBefore[i])) {
    throw new ShopifyApiError(
      `Verificatie na schrijven mislukt: overige customAttributes van ${orderGid} zijn gewijzigd.`,
    );
  }

  return {
    orderGid: written.id,
    orderName: current.order.name,
    written: true,
    previous,
    // Copies beyond the first — deliberately NOT `existing.length -
    // expectedCount`, which would count the single legitimate key a clear
    // removes as though it were a stray duplicate and inflate the
    // duplicate-repair metrics this metadata exists to feed.
    duplicatesRemoved: Math.max(0, existing.length - 1),
  };
}
