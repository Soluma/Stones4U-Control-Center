import "server-only";
import { shopifyGraphQL } from "./client";
import type { ShopifyCustomerSummary } from "./types";

const CUSTOMER_FIELDS = /* GraphQL */ `
  id
  displayName
  firstName
  lastName
  email
  phone
  defaultAddress {
    address1
    city
    company
  }
  numberOfOrders
  amountSpent {
    amount
    currencyCode
  }
`;

const SEARCH_CUSTOMERS_QUERY = /* GraphQL */ `
  query SearchCustomers($query: String!, $first: Int!) {
    customers(first: $first, query: $query) {
      edges {
        node {
          ${CUSTOMER_FIELDS}
        }
      }
    }
  }
`;

const CUSTOMER_BY_ID_QUERY = /* GraphQL */ `
  query CustomerById($id: ID!) {
    customer(id: $id) {
      ${CUSTOMER_FIELDS}
    }
  }
`;

type RawShopifyCustomer = {
  id: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  defaultAddress: { address1: string | null; city: string | null; company: string | null } | null;
  numberOfOrders: string;
  amountSpent: { amount: string; currencyCode: string } | null;
};

function mapCustomer(raw: RawShopifyCustomer): ShopifyCustomerSummary {
  const legacyId = raw.id.split("/").pop() ?? raw.id;
  const addressParts = [raw.defaultAddress?.address1, raw.defaultAddress?.city].filter(Boolean);
  return {
    gid: raw.id,
    legacyId,
    displayName: raw.displayName,
    firstName: raw.firstName,
    lastName: raw.lastName,
    email: raw.email,
    phone: raw.phone,
    company: raw.defaultAddress?.company ?? null,
    defaultAddressSummary: addressParts.length > 0 ? addressParts.join(", ") : null,
    numberOfOrders: Number(raw.numberOfOrders) || 0,
    amountSpent: raw.amountSpent,
  };
}

function escapeShopifySearchTerm(term: string): string {
  // Shopify's search-query syntax treats quotes/colons specially; a plain
  // free-text search wrapped in quotes with internal quotes escaped is safe
  // for name/email/phone/company lookups (no user input is ever concatenated
  // unescaped into the query string).
  return term.replace(/"/g, '\\"');
}

/** Read-only. Searches Shopify customers by free text (name, email, phone,
 * or company — whatever Shopify's own search matches). */
export async function searchShopifyCustomers(term: string, first = 10): Promise<ShopifyCustomerSummary[]> {
  const trimmed = term.trim();
  if (trimmed.length === 0) return [];

  const data = await shopifyGraphQL<{ customers: { edges: { node: RawShopifyCustomer }[] } }>(
    SEARCH_CUSTOMERS_QUERY,
    { query: escapeShopifySearchTerm(trimmed), first },
  );

  return data.customers.edges.map((edge) => mapCustomer(edge.node));
}

/** Read-only. Fetches a single Shopify customer by GID (gid://shopify/Customer/…). */
export async function getShopifyCustomerByGid(gid: string): Promise<ShopifyCustomerSummary | null> {
  const data = await shopifyGraphQL<{ customer: RawShopifyCustomer | null }>(CUSTOMER_BY_ID_QUERY, { id: gid });
  return data.customer ? mapCustomer(data.customer) : null;
}
