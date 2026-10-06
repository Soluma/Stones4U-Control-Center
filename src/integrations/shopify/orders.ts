import "server-only";
import { shopifyGraphQL, getShopifyConfig } from "./client";
import { buildShopifyAdminUrl } from "./admin-links";
import type { CustomerOrdersResult, ShopifyOrderSummary } from "./types";

const CUSTOMER_ORDERS_QUERY = /* GraphQL */ `
  query CustomerOrders($id: ID!, $first: Int!) {
    customer(id: $id) {
      numberOfOrders
      amountSpent {
        amount
        currencyCode
      }
      orders(first: $first, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            legacyResourceId
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            currentTotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            lineItems(first: 1) {
              # only used for a fast, approximate "has line items" signal;
              # full line-item detail is out of scope for Phase 1
              edges {
                node {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
`;

type RawOrderNode = {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  lineItems: { edges: { node: { id: string } }[] };
};

type RawCustomerOrdersResponse = {
  customer: {
    numberOfOrders: string;
    amountSpent: { amount: string; currencyCode: string } | null;
    orders: { edges: { node: RawOrderNode }[] };
  } | null;
};

const OPEN_FINANCIAL_STATUSES = new Set(["PENDING", "PARTIALLY_PAID", "AUTHORIZED"]);

/** Read-only. Order history + totals for a customer, used to render the
 * Customer 360 "Orders" tab and header summary (order count, total spent,
 * outstanding orders, last order date). */
export async function getShopifyCustomerOrders(customerGid: string, first = 20): Promise<CustomerOrdersResult> {
  const config = getShopifyConfig();
  const data = await shopifyGraphQL<RawCustomerOrdersResponse>(CUSTOMER_ORDERS_QUERY, {
    id: customerGid,
    first,
  });

  if (!data.customer) {
    return { orders: [], totalOrders: 0, totalSpent: null, outstandingOrders: 0, lastOrderAt: null };
  }

  const orders: ShopifyOrderSummary[] = data.customer.orders.edges.map(({ node }) => ({
    gid: node.id,
    name: node.name,
    createdAt: node.createdAt,
    displayFinancialStatus: node.displayFinancialStatus,
    displayFulfillmentStatus: node.displayFulfillmentStatus,
    currentTotalPriceSet: node.currentTotalPriceSet.shopMoney,
    lineItemCount: node.lineItems.edges.length,
    adminUrl: buildShopifyAdminUrl(config.domain, "orders", node.legacyResourceId),
  }));

  const outstandingOrders = orders.filter(
    (order) => order.displayFinancialStatus && OPEN_FINANCIAL_STATUSES.has(order.displayFinancialStatus),
  ).length;

  return {
    orders,
    totalOrders: Number(data.customer.numberOfOrders) || 0,
    totalSpent: data.customer.amountSpent,
    outstandingOrders,
    lastOrderAt: orders[0]?.createdAt ?? null,
  };
}

// ── Global order list (Sales → Orders) ────────────────────────────────────

const ORDERS_PAGE_QUERY = /* GraphQL */ `
  query OrdersPage($first: Int, $last: Int, $after: String, $before: String, $query: String) {
    orders(first: $first, last: $last, after: $after, before: $before, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
      edges {
        node {
          id
          legacyResourceId
          name
          createdAt
          cancelledAt
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
            displayName
          }
        }
      }
    }
  }
`;

export const ORDERS_PAGE_SIZE = 50;

export type ShopifyOrderListItem = {
  gid: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  currentTotalPriceSet: { amount: string; currencyCode: string };
  customer: { gid: string; displayName: string } | null;
  adminUrl: string;
};

export type ShopifyOrderPage = {
  orders: ShopifyOrderListItem[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
};

type RawOrderListNode = {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  customer: { id: string; displayName: string } | null;
};

type RawOrdersPageResponse = {
  orders: { pageInfo: ShopifyOrderPage["pageInfo"]; edges: { node: RawOrderListNode }[] };
};

/** Read-only. One page of the shop's orders, newest first — one GraphQL
 * request per page, filtered by Shopify itself (`query`), never a bulk fetch
 * filtered in the browser. `before` pages back towards newer orders. */
export async function listShopifyOrders(options: {
  query?: string;
  after?: string;
  before?: string;
  pageSize?: number;
} = {}): Promise<ShopifyOrderPage> {
  const config = getShopifyConfig();
  const pageSize = options.pageSize ?? ORDERS_PAGE_SIZE;
  const paging = options.before ? { last: pageSize, before: options.before } : { first: pageSize, after: options.after ?? null };
  const data = await shopifyGraphQL<RawOrdersPageResponse>(ORDERS_PAGE_QUERY, {
    ...paging,
    query: options.query?.trim() || null,
  });

  return {
    pageInfo: data.orders.pageInfo,
    orders: data.orders.edges.map(({ node }) => ({
      gid: node.id,
      legacyResourceId: node.legacyResourceId,
      name: node.name,
      createdAt: node.createdAt,
      cancelledAt: node.cancelledAt,
      displayFinancialStatus: node.displayFinancialStatus,
      displayFulfillmentStatus: node.displayFulfillmentStatus,
      currentTotalPriceSet: node.currentTotalPriceSet.shopMoney,
      customer: node.customer ? { gid: node.customer.id, displayName: node.customer.displayName } : null,
      adminUrl: buildShopifyAdminUrl(config.domain, "orders", node.legacyResourceId),
    })),
  };
}
