import "server-only";
import { shopifyGraphQL } from "./client";

// Read-only, global (not per-customer) order/draft-order search — feeds the
// command palette's "orders" group (docs/platform-discovery/28-PHASE-3-ARCHITECTURE.md
// §5, docs/platform-discovery/29-PHASE-3-BUILD-SPEC.md §4). Deliberately a
// separate module from orders.ts/draft-orders.ts (which are always scoped
// to one known customer) — this one searches Shopify's top-level orders/
// draftOrders connections by name/number across the whole shop.

const SEARCH_ORDERS_QUERY = /* GraphQL */ `
  query SearchOrders($query: String!, $first: Int!) {
    orders(first: $first, query: $query) {
      edges {
        node {
          id
          name
          customer {
            id
            displayName
          }
        }
      }
    }
  }
`;

const SEARCH_DRAFT_ORDERS_QUERY = /* GraphQL */ `
  query SearchDraftOrders($query: String!, $first: Int!) {
    draftOrders(first: $first, query: $query) {
      edges {
        node {
          id
          name
          customer {
            id
            displayName
          }
        }
      }
    }
  }
`;

type RawNode = { id: string; name: string; customer: { id: string; displayName: string } | null };
type RawOrdersResponse = { orders: { edges: { node: RawNode }[] } };
type RawDraftOrdersResponse = { draftOrders: { edges: { node: RawNode }[] } };

export type OrderSearchResult = {
  kind: "order" | "draft_order";
  gid: string;
  name: string;
  customerGid: string;
  customerName: string;
};

function toResults(edges: { node: RawNode }[], kind: "order" | "draft_order"): OrderSearchResult[] {
  return edges
    .filter(({ node }) => node.customer !== null)
    .map(({ node }) => ({ kind, gid: node.id, name: node.name, customerGid: node.customer!.id, customerName: node.customer!.displayName }));
}

/** Matches on order/draft-order name (e.g. "1001" finds "#1001") — never
 * on line-item/customer free text, keeping this a narrow "find this
 * specific order" lookup rather than a second customer-search path.
 * Orders/draft orders without an attached Shopify customer are skipped —
 * there is nowhere in Control Center to navigate to for one (no
 * CustomerProfile can exist without a Shopify customer GID).
 *
 * Orders and draft orders are deliberately two separate GraphQL requests,
 * not one combined query: Shopify returns `data: null` for the *entire*
 * response when any single top-level field is scope-denied, so a shop
 * without read_draft_orders granted would silently break real order
 * search too if the two were combined. Each is fail-isolated so a
 * draft-order scope/outage never takes down order search.
 *
 * The two connections also need different query syntax: `orders` honors
 * a `name:`-scoped wildcard (`name:*1001*`), but on `draftOrders` that
 * same scoped filter is silently ignored by Shopify and returns an
 * unfiltered page — confirmed directly against the live API. A bare
 * wildcard (`*D570*`, no field prefix) is what actually filters
 * `draftOrders` correctly, so the two queries use different query
 * strings even though they search for the same term. */
export async function searchShopifyOrders(term: string, limit = 8): Promise<OrderSearchResult[]> {
  const sanitizedTerm = term.replace(/["\\]/g, "");
  const ordersQuery = `name:*${sanitizedTerm}*`;
  const draftOrdersQuery = `*${sanitizedTerm}*`;

  const [ordersOutcome, draftOrdersOutcome] = await Promise.allSettled([
    shopifyGraphQL<RawOrdersResponse>(SEARCH_ORDERS_QUERY, { query: ordersQuery, first: limit }),
    shopifyGraphQL<RawDraftOrdersResponse>(SEARCH_DRAFT_ORDERS_QUERY, { query: draftOrdersQuery, first: limit }),
  ]);

  const orders = ordersOutcome.status === "fulfilled" ? toResults(ordersOutcome.value.orders.edges, "order") : [];
  if (ordersOutcome.status === "rejected") {
    console.error("shopify_order_search_orders_failed", ordersOutcome.reason);
  }

  const draftOrders = draftOrdersOutcome.status === "fulfilled" ? toResults(draftOrdersOutcome.value.draftOrders.edges, "draft_order") : [];
  if (draftOrdersOutcome.status === "rejected") {
    console.error("shopify_order_search_draft_orders_failed", draftOrdersOutcome.reason);
  }

  return [...orders, ...draftOrders].slice(0, limit);
}
