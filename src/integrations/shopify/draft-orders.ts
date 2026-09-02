import "server-only";
import { shopifyGraphQL, getShopifyConfig } from "./client";
import { buildShopifyAdminUrl } from "./admin-links";
import type { ShopifyDraftOrderSummary, CustomerDraftOrdersResult } from "./types";

// Read-only Shopify draft orders (docs/platform-discovery/27-PHASE-3-DISCOVERY.md
// §3, docs/platform-discovery/29-PHASE-3-BUILD-SPEC.md §9). Uses the exact
// same client-credentials transport as orders.ts/customers.ts — no new auth
// pattern, no static token. `read_draft_orders` has been a granted scope
// since Phase 1 (README.md) but was never queried until now.

// NOTE: Customer has no "draftOrders" field on the Shopify Admin GraphQL API
// (confirmed against the live schema during Phase 3A build) — draft orders
// are queried via the top-level draftOrders connection filtered by
// customer_id, exactly like orders.ts does for real orders.
const CUSTOMER_DRAFT_ORDERS_QUERY = /* GraphQL */ `
  query CustomerDraftOrders($query: String!, $first: Int!) {
    draftOrders(first: $first, sortKey: UPDATED_AT, reverse: true, query: $query) {
      edges {
        node {
          id
          legacyResourceId
          name
          status
          createdAt
          updatedAt
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          invoiceUrl
          order {
            id
            legacyResourceId
            name
          }
        }
      }
    }
  }
`;

type RawDraftOrderNode = {
  id: string;
  legacyResourceId: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  invoiceUrl: string | null;
  order: { id: string; legacyResourceId: string; name: string } | null;
};

type RawCustomerDraftOrdersResponse = {
  draftOrders: { edges: { node: RawDraftOrderNode }[] };
};

/** Shopify's customer_id query filter wants the bare numeric ID, not the GID. */
function legacyIdFromGid(gid: string): string | null {
  const match = /\/(\d+)$/.exec(gid);
  return match?.[1] ?? null;
}

/** Read-only. Open/invoiced/completed draft orders for a customer, for the
 * Customer 360 "Commercieel" tab's "Conceptbestellingen" section
 * (docs/platform-discovery/28-PHASE-3-ARCHITECTURE.md §4). Never throws for
 * "no draft orders" — only for a genuine Shopify/config failure, exactly
 * like getShopifyCustomerOrders(), so a transient Shopify hiccup on this
 * one section doesn't have to take down the rest of Customer 360 (the
 * caller is expected to catch this independently — see
 * src/app/(app)/customers/[id]/page.tsx). */
export async function getShopifyCustomerDraftOrders(customerGid: string, first = 20): Promise<CustomerDraftOrdersResult> {
  const config = getShopifyConfig();
  const legacyId = legacyIdFromGid(customerGid);
  if (!legacyId) {
    return { draftOrders: [] };
  }

  const data = await shopifyGraphQL<RawCustomerDraftOrdersResponse>(CUSTOMER_DRAFT_ORDERS_QUERY, {
    query: `customer_id:${legacyId}`,
    first,
  });

  const draftOrders: ShopifyDraftOrderSummary[] = data.draftOrders.edges.map(({ node }) => ({
    gid: node.id,
    name: node.name,
    status: node.status,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    totalPriceSet: node.totalPriceSet.shopMoney,
    invoiceUrl: node.invoiceUrl,
    completedOrder: node.order ? { gid: node.order.id, name: node.order.name, adminUrl: buildShopifyAdminUrl(config.domain, "orders", node.order.legacyResourceId) } : null,
    adminUrl: buildShopifyAdminUrl(config.domain, "draft_orders", node.legacyResourceId),
  }));

  return { draftOrders };
}
