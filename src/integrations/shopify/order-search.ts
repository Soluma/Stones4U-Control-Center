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

// Phase 7 (5A) — dedicated draft-order search for the "create a delivery
// date link" staff flow (docs/QUOTE-DELIVERY-DATE-MANUAL-ACTIVATION.md). A
// new, separate query rather than reusing SEARCH_DRAFT_ORDERS_QUERY above:
// that one drops any result without a Shopify customer (there is nowhere
// in the command palette to navigate a customer-less order to), but a
// delivery-date handoff must stay creatable for a draft order with no
// attached customer — a real, valid state (docs/QUOTE-DELIVERY-DATE-PORTAL-
// BUILD.md §1: customerProfileId is optional). Also needs `status`, which
// the command-palette query never fetches. Read-only, no new Shopify
// scope — same `read_draft_orders` already granted.
const SEARCH_DRAFT_ORDERS_FOR_HANDOFF_QUERY = /* GraphQL */ `
  query SearchDraftOrdersForHandoff($query: String!, $first: Int!) {
    draftOrders(first: $first, query: $query) {
      edges {
        node {
          id
          legacyResourceId
          name
          status
          customer {
            id
            displayName
          }
        }
      }
    }
  }
`;

type RawDraftOrderForHandoffNode = {
  id: string;
  legacyResourceId: string;
  name: string;
  status: string;
  customer: { id: string; displayName: string } | null;
};
type RawDraftOrdersForHandoffResponse = { draftOrders: { edges: { node: RawDraftOrderForHandoffNode }[] } };

export type DraftOrderForHandoffResult = {
  gid: string;
  legacyResourceId: string;
  name: string;
  status: string;
  customerGid: string | null;
  customerName: string | null;
};

/** Read-only. Matches on draft-order name only (same bare-wildcard syntax
 * as searchShopifyOrders() above — a scoped `name:` filter is silently
 * ignored by Shopify on draftOrders, confirmed live). Never mutates
 * anything — search/selection is always a plain GraphQL query. */
export async function searchDraftOrdersForHandoff(term: string, limit = 8): Promise<DraftOrderForHandoffResult[]> {
  const sanitizedTerm = term.replace(/["\\]/g, "");
  const query = `*${sanitizedTerm}*`;

  const data = await shopifyGraphQL<RawDraftOrdersForHandoffResponse>(SEARCH_DRAFT_ORDERS_FOR_HANDOFF_QUERY, {
    query,
    first: limit,
  });

  return data.draftOrders.edges.map(({ node }) => ({
    gid: node.id,
    legacyResourceId: node.legacyResourceId,
    name: node.name,
    status: node.status,
    customerGid: node.customer?.id ?? null,
    customerName: node.customer?.displayName ?? null,
  }));
}

// Phase 6E — real-Order equivalent of searchDraftOrdersForHandoff() above,
// for the staff "create a delivery date link for an Order" flow
// (docs/ORDER-DELIVERY-HANDOFF-FOUNDATION.md §"Staff Order handoff
// management"). Deliberately does not fetch/return customer.displayName —
// unlike the Draft search above, this result set is minimal-by-design
// (build instruction §4: "Do NOT return/render... unnecessary PII"); the
// customer GID is fetched only so the create step can do server-side
// CustomerProfile matching, never rendered. Also fetches just enough to
// show honest staff context up front (cancelled state, whether a delivery
// date preference already exists) without a second round-trip.
const SEARCH_ORDERS_FOR_HANDOFF_QUERY = /* GraphQL */ `
  query SearchOrdersForHandoff($query: String!, $first: Int!) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          createdAt
          cancelledAt
          displayFulfillmentStatus
          customer { id }
          shippingAddress { city }
          customAttributes { key value }
        }
      }
    }
  }
`;

type RawOrderForHandoffSearchNode = {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  displayFulfillmentStatus: string;
  customer: { id: string } | null;
  shippingAddress: { city: string | null } | null;
  customAttributes: { key: string; value: string }[];
};
type RawOrdersForHandoffSearchResponse = { orders: { edges: { node: RawOrderForHandoffSearchNode }[] } };

export type OrderForHandoffSearchResult = {
  gid: string;
  name: string;
  createdAt: string;
  isCancelled: boolean;
  fulfillmentStatus: string;
  customerGid: string | null;
  hasShippingAddress: boolean;
  // The actual ISO value when Shopify already has one, `null` otherwise —
  // not merely a boolean, so staff can be shown *which* date is already
  // known (build instruction §2/§12/§13). Deliberately carries no
  // assumption about where this value came from (quote, Draft, staff,
  // customer portal) — see createOrderDeliveryHandoffForStaff()'s doc
  // comment in delivery-handoff.service.ts for the full reasoning.
  requestedDeliveryDate: string | null;
};

/** Read-only. Matches on Order name only (`name:*term*` — Shopify honors a
 * scoped `name:` wildcard on the `orders` connection, confirmed live and
 * already relied on by searchShopifyOrders() above; unlike `draftOrders`,
 * which silently ignores that same scoped filter). Never mutates anything
 * — this is purely the search step; the actual handoff creation always
 * re-reads the specific selected Order again via getOrderForHandoff()
 * immediately before creating (build instruction §6), so a result from
 * this search is never trusted as still-current by the time staff acts on
 * it. */
export async function searchOrdersForHandoff(term: string, limit = 8): Promise<OrderForHandoffSearchResult[]> {
  const sanitizedTerm = term.replace(/["\\]/g, "");
  const query = `name:*${sanitizedTerm}*`;

  const data = await shopifyGraphQL<RawOrdersForHandoffSearchResponse>(SEARCH_ORDERS_FOR_HANDOFF_QUERY, {
    query,
    first: limit,
  });

  return data.orders.edges.map(({ node }) => ({
    gid: node.id,
    name: node.name,
    createdAt: node.createdAt,
    isCancelled: !!node.cancelledAt,
    fulfillmentStatus: node.displayFulfillmentStatus,
    customerGid: node.customer?.id ?? null,
    hasShippingAddress: !!node.shippingAddress,
    requestedDeliveryDate: node.customAttributes.find((a) => a.key === "requested_delivery_date")?.value ?? null,
  }));
}
