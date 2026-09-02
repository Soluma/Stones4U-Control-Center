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
