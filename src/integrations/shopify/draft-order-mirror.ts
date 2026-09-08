import "server-only";
import { shopifyGraphQL } from "./client";
import { assertShopifyWriteAllowed } from "./write-safety-guard";
import { ShopifyApiError } from "./errors";

// Control Center's first-ever Shopify WRITE (Phase 7 — Quote Delivery Date
// Handoff). Deliberately kept in its own file, separate from the
// read-only draft-orders.ts, so the Phase-1 "no mutation helpers" boundary
// stays visible and easy to review/revert — see
// docs/QUOTE-DELIVERY-DATE-PORTAL-DISCOVERY.md §7.

const REQUESTED_DELIVERY_DATE_ATTRIBUTE_KEY = "requested_delivery_date";

// Deliberately minimal: id, invoiceUrl, customAttributes only — never the
// nested `customer` object. OfferteApp's equivalent build proved live that
// querying DraftOrder.customer requires a separate read_customers scope;
// this flow never needs customer data, so that scope is never requested.
const DRAFT_ORDER_FOR_MIRROR_QUERY = /* GraphQL */ `
  query DraftOrderForMirror($id: ID!) {
    draftOrder(id: $id) {
      id
      invoiceUrl
      customAttributes {
        key
        value
      }
    }
  }
`;

type RawDraftOrderForMirror = {
  draftOrder: {
    id: string;
    invoiceUrl: string | null;
    customAttributes: { key: string; value: string }[];
  } | null;
};

const DRAFT_ORDER_UPDATE_MUTATION = /* GraphQL */ `
  mutation DraftOrderUpdateRequestedDeliveryDate($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type DraftOrderUpdateResponse = {
  draftOrderUpdate: {
    draftOrder: { id: string } | null;
    userErrors: { field: string[] | null; message: string }[];
  };
};

export type DraftOrderMirrorResult = { invoiceUrl: string | null };

/**
 * Read-merge-write: sets exactly one customAttribute
 * (`requested_delivery_date`) on the given Draft Order, preserving every
 * other existing attribute untouched, never duplicating the key.
 *
 * Calls assertShopifyWriteAllowed() first, every time, no exceptions
 * (CLAUDE.md) — never call the mutation below directly from anywhere else.
 * `input` contains ONLY `customAttributes`, never a broader payload that
 * could overwrite line items/customer/shipping (same hard gate proven in
 * OfferteApp's equivalent build).
 */
export async function mirrorRequestedDeliveryDateToShopify(
  draftOrderGid: string,
  dateIso: string,
): Promise<DraftOrderMirrorResult> {
  await assertShopifyWriteAllowed();

  const current = await shopifyGraphQL<RawDraftOrderForMirror>(DRAFT_ORDER_FOR_MIRROR_QUERY, { id: draftOrderGid });
  if (!current.draftOrder) {
    throw new ShopifyApiError(`Draft Order ${draftOrderGid} bestaat niet (meer) in Shopify.`);
  }

  const merged = current.draftOrder.customAttributes.filter((a) => a.key !== REQUESTED_DELIVERY_DATE_ATTRIBUTE_KEY);
  merged.push({ key: REQUESTED_DELIVERY_DATE_ATTRIBUTE_KEY, value: dateIso });

  const result = await shopifyGraphQL<DraftOrderUpdateResponse>(DRAFT_ORDER_UPDATE_MUTATION, {
    id: draftOrderGid,
    input: { customAttributes: merged },
  });

  const errors = result.draftOrderUpdate.userErrors;
  if (errors.length > 0) {
    throw new ShopifyApiError(`Shopify draftOrderUpdate gaf userErrors terug.`, { graphqlErrors: errors });
  }

  return { invoiceUrl: current.draftOrder.invoiceUrl };
}
