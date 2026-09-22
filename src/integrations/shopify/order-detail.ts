import "server-only";
import { shopifyGraphQL, getShopifyConfig } from "./client";
import { buildShopifyAdminUrl } from "./admin-links";

// Read-only. The Order as Customer 360's own order page shows it: header
// plus the product lines.
//
// The existing reads answer narrower questions — orders.ts lists a
// customer's orders without line detail, order-for-handoff.ts asks whether
// an Order is a handoff candidate — so neither can serve this page. Line
// items are fetched here because the logistics adapter deliberately returns
// pick state *without* product titles (OfferteApp docs/CRM-LOGISTICS-API.md
// §B): Shopify stays the source of the product, OfferteApp of the picking,
// and the page joins them on the line-item id.

const ORDER_DETAIL_QUERY = /* GraphQL */ `
  query OrderDetail($id: ID!) {
    order(id: $id) {
      id
      legacyResourceId
      name
      createdAt
      cancelledAt
      note
      displayFinancialStatus
      displayFulfillmentStatus
      currentTotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      customer {
        id
      }
      lineItems(first: 100) {
        pageInfo {
          hasNextPage
        }
        edges {
          node {
            id
            title
            variantTitle
            sku
            quantity
            currentQuantity
          }
        }
      }
    }
  }
`;

type RawOrderDetail = {
  order: {
    id: string;
    legacyResourceId: string;
    name: string;
    createdAt: string;
    cancelledAt: string | null;
    note: string | null;
    displayFinancialStatus: string | null;
    displayFulfillmentStatus: string | null;
    currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
    customer: { id: string } | null;
    lineItems: {
      pageInfo: { hasNextPage: boolean };
      edges: { node: RawLineItem }[];
    };
  } | null;
};

type RawLineItem = {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  currentQuantity: number;
};

export type ShopifyOrderLineItem = {
  /** GID, e.g. `gid://shopify/LineItem/123` — the join key with OfferteApp. */
  gid: string;
  /** The numeric tail of the GID, which is how OfferteApp stores it. */
  legacyId: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  /** Quantity after edits/refunds — what the warehouse actually picks. */
  currentQuantity: number;
};

export type ShopifyOrderDetail = {
  gid: string;
  legacyId: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  note: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  currentTotalPriceSet: { amount: string; currencyCode: string };
  customerGid: string | null;
  lineItems: ShopifyOrderLineItem[];
  /** True when the order has more than 100 lines: the page says so rather
   * than quietly showing a partial list next to pick progress. */
  hasMoreLineItems: boolean;
  adminUrl: string;
};

function legacyIdOf(gid: string): string {
  return /\/(\d+)$/.exec(gid)?.[1] ?? "";
}

export async function getShopifyOrderDetail(orderGid: string): Promise<ShopifyOrderDetail | null> {
  const config = getShopifyConfig();
  const data = await shopifyGraphQL<RawOrderDetail>(ORDER_DETAIL_QUERY, { id: orderGid });
  if (!data.order) return null;
  const order = data.order;

  return {
    gid: order.id,
    legacyId: order.legacyResourceId,
    name: order.name,
    createdAt: order.createdAt,
    cancelledAt: order.cancelledAt,
    note: order.note,
    displayFinancialStatus: order.displayFinancialStatus,
    displayFulfillmentStatus: order.displayFulfillmentStatus,
    currentTotalPriceSet: order.currentTotalPriceSet.shopMoney,
    customerGid: order.customer?.id ?? null,
    lineItems: order.lineItems.edges.map(({ node }) => ({
      gid: node.id,
      legacyId: legacyIdOf(node.id),
      title: node.title,
      variantTitle: node.variantTitle,
      sku: node.sku,
      quantity: node.quantity,
      currentQuantity: node.currentQuantity,
    })),
    hasMoreLineItems: order.lineItems.pageInfo.hasNextPage,
    adminUrl: buildShopifyAdminUrl(config.domain, "orders", order.legacyResourceId),
  };
}
