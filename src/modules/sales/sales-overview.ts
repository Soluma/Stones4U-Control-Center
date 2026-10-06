import "server-only";
import { prisma } from "@/platform/db/prisma";
import { normalizeEmail } from "@/lib/email";
import { customerDisplayName } from "@/modules/crm/customer-identity";
import { createQuotesAdapter, type QuoteListResult, type QuoteSummary } from "@/integrations/quotes/adapter";
import { getDraftOrderNames } from "@/integrations/shopify/draft-orders";
import { listShopifyOrders, type ShopifyOrderListItem, type ShopifyOrderPage } from "@/integrations/shopify/orders";
import { createLogisticsAdapter } from "@/integrations/logistics/adapter";
import type { OrderLogisticsSummary } from "@/integrations/logistics/types";
import { buildOrderSearchQuery } from "./order-presentation";

// Server-side loading for Sales → Offertes and Sales → Orders. Every external
// system is called once per page load (never once per row), and each one
// fails on its own without taking the page down.

export type ResolvedCustomer = { id: string; name: string };

const PROFILE_SELECT = { id: true, shopifyCustomerGid: true, email: true, displayName: true, companyName: true, customerTypeOverride: true } as const;

/** Exact Shopify Customer GID → CustomerProfile, in one query. */
export async function resolveCustomersByShopifyGid(gids: string[]): Promise<Map<string, ResolvedCustomer>> {
  const unique = [...new Set(gids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const profiles = await prisma.customerProfile.findMany({ where: { shopifyCustomerGid: { in: unique } }, select: PROFILE_SELECT });
  return new Map(profiles.map((p) => [p.shopifyCustomerGid, { id: p.id, name: customerDisplayName(p) }]));
}

/** Exact (normalized, case-insensitive) e-mail → CustomerProfile, in one
 * query. An address shared by more than one profile resolves to nobody:
 * picking one would be a guess. */
export async function resolveCustomersByExactEmail(emails: (string | null)[]): Promise<Map<string, ResolvedCustomer>> {
  const unique = [...new Set(emails.map((e) => normalizeEmail(e)).filter((e): e is string => !!e))];
  if (unique.length === 0) return new Map();
  const profiles = await prisma.customerProfile.findMany({
    where: { OR: unique.map((email) => ({ email: { equals: email, mode: "insensitive" as const } })) },
    select: PROFILE_SELECT,
  });
  const byEmail = new Map<string, ResolvedCustomer[]>();
  for (const p of profiles) {
    const key = normalizeEmail(p.email);
    if (!key) continue;
    byEmail.set(key, [...(byEmail.get(key) ?? []), { id: p.id, name: customerDisplayName(p) }]);
  }
  const result = new Map<string, ResolvedCustomer>();
  for (const [email, matches] of byEmail) if (matches.length === 1) result.set(email, matches[0]!);
  return result;
}

export type QuoteOverviewRow = QuoteSummary & { customer: ResolvedCustomer | null };

export type QuotesOverview = QuoteListResult & { rows: QuoteOverviewRow[]; draftOrderNames: Map<string, string> };

/** 1 request per configured quote source, then 2 DB queries and at most 1
 * Shopify request (draft-order names) for the whole result set. */
export async function loadQuotesOverview(term: string): Promise<QuotesOverview> {
  const result = await createQuotesAdapter().listQuotes({ mode: "search", term });
  const gidQuotes = result.quotes.filter((q) => q.shopifyCustomerGid);
  const [byGid, byEmail, draftOrderNames] = await Promise.all([
    resolveCustomersByShopifyGid(gidQuotes.map((q) => q.shopifyCustomerGid!)),
    resolveCustomersByExactEmail(result.quotes.map((q) => q.email)),
    getDraftOrderNames(result.quotes.map((q) => q.shopifyDraftOrderGid).filter((g): g is string => !!g)),
  ]);
  const rows = result.quotes.map((quote) => {
    // 1. Shopify Customer GID, 2. exact e-mail — never a name or fuzzy match.
    const customer =
      (quote.shopifyCustomerGid ? byGid.get(quote.shopifyCustomerGid) : undefined) ??
      byEmail.get(normalizeEmail(quote.email) ?? "") ??
      null;
    return { ...quote, customer };
  });
  return { ...result, rows, draftOrderNames };
}

export type OrdersLogistics = {
  byOrderId: Map<string, OrderLogisticsSummary>;
  /** OfferteApp did not answer (or only partly) — not the same as "no data". */
  unavailable: boolean;
  notConfigured: boolean;
};

export type OrderOverviewRow = ShopifyOrderListItem & { customerProfile: ResolvedCustomer | null };

export type OrdersOverview =
  | { ok: true; page: ShopifyOrderPage; rows: OrderOverviewRow[]; logistics: OrdersLogistics }
  | { ok: false };

/** 1 Shopify request for the page, 1 DB query for customers and one
 * OfferteApp request per 25 orders (2 for a full page of 50). */
export async function loadOrdersOverview(filter: {
  term?: string;
  financial?: string;
  fulfillment?: string;
  after?: string;
  before?: string;
}): Promise<OrdersOverview> {
  let page: ShopifyOrderPage;
  try {
    page = await listShopifyOrders({ query: buildOrderSearchQuery(filter), after: filter.after, before: filter.before });
  } catch (error) {
    console.error("orders_overview_shopify_failed", error instanceof Error ? error.message : error);
    return { ok: false };
  }

  const logisticsAdapter = createLogisticsAdapter();
  const [customers, logistics] = await Promise.all([
    resolveCustomersByShopifyGid(page.orders.map((o) => o.customer?.gid ?? "").filter(Boolean)),
    (async (): Promise<OrdersLogistics> => {
      if (!logisticsAdapter.status().available) return { byOrderId: new Map(), unavailable: true, notConfigured: true };
      try {
        const result = await logisticsAdapter.getForOrders(page.orders.map((o) => o.legacyResourceId));
        return result.ok
          ? { byOrderId: result.byOrderId, unavailable: result.partial, notConfigured: false }
          : { byOrderId: new Map(), unavailable: true, notConfigured: false };
      } catch (error) {
        console.error("orders_overview_logistics_failed", error instanceof Error ? error.message : error);
        return { byOrderId: new Map(), unavailable: true, notConfigured: false };
      }
    })(),
  ]);

  const rows = page.orders.map((order) => ({
    ...order,
    customerProfile: order.customer ? (customers.get(order.customer.gid) ?? null) : null,
  }));
  return { ok: true, page, rows, logistics };
}
