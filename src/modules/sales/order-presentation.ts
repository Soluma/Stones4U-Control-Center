// How orders read on the Sales → Orders overview, and how its filters map
// onto Shopify's own order search. Presentation only: Shopify's statuses are
// translated, never re-derived; an unknown value shows as Shopify wrote it.

import type { HandoffType, OrderLogisticsSummary } from "@/integrations/logistics/types";
import { needsAttention } from "@/modules/logistics/presentation";

type Option = { value: string; label: string; query: string };

/** Betaalstatus filter → Shopify `financial_status:` search value. */
export const FINANCIAL_FILTERS: Option[] = [
  { value: "pending", label: "Openstaand", query: "financial_status:pending" },
  { value: "partially_paid", label: "Deels betaald", query: "financial_status:partially_paid" },
  { value: "authorized", label: "Geautoriseerd", query: "financial_status:authorized" },
  { value: "paid", label: "Betaald", query: "financial_status:paid" },
  { value: "refunded", label: "Terugbetaald", query: "financial_status:refunded" },
  { value: "voided", label: "Vervallen", query: "financial_status:voided" },
];

/** Fulfillment filter → Shopify `fulfillment_status:` search value. */
export const FULFILLMENT_FILTERS: Option[] = [
  { value: "unfulfilled", label: "Niet verzonden", query: "fulfillment_status:unfulfilled" },
  { value: "partial", label: "Deels verzonden", query: "fulfillment_status:partial" },
  { value: "fulfilled", label: "Verzonden", query: "fulfillment_status:fulfilled" },
];

export const HANDOFF_FILTERS: { value: HandoffType; label: string }[] = [
  { value: "VAN_EIJK", label: "Van Eijk" },
  { value: "HOEFNAGELS", label: "Hoefnagels" },
  { value: "CUSTOMER_PICKUP", label: "Afhalen klant" },
  { value: "UNKNOWN", label: "Onbekend" },
];

export function pickFilter(options: { value: string }[], value: string | null | undefined): string {
  return options.some((o) => o.value === value) ? (value as string) : "";
}

/** The Shopify search string for one page of orders. The order-number match
 * uses the same `name:*term*` syntax the command palette already relies on. */
export function buildOrderSearchQuery(filter: { term?: string; financial?: string; fulfillment?: string }): string {
  const parts: string[] = [];
  const term = filter.term?.replace(/["\\]/g, "").replace(/^#/, "").trim();
  if (term) parts.push(`name:*${term}*`);
  const financial = FINANCIAL_FILTERS.find((o) => o.value === filter.financial);
  if (financial) parts.push(financial.query);
  const fulfillment = FULFILLMENT_FILTERS.find((o) => o.value === filter.fulfillment);
  if (fulfillment) parts.push(fulfillment.query);
  return parts.join(" ");
}

const FINANCIAL_LABELS: Record<string, string> = {
  PENDING: "Openstaand",
  PARTIALLY_PAID: "Deels betaald",
  AUTHORIZED: "Geautoriseerd",
  PAID: "Betaald",
  PARTIALLY_REFUNDED: "Deels terugbetaald",
  REFUNDED: "Terugbetaald",
  VOIDED: "Vervallen",
  EXPIRED: "Verlopen",
};

const FINANCIAL_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  PAID: "success",
  PENDING: "warning",
  PARTIALLY_PAID: "warning",
  AUTHORIZED: "warning",
  PARTIALLY_REFUNDED: "neutral",
  REFUNDED: "neutral",
  VOIDED: "danger",
  EXPIRED: "danger",
};

const FULFILLMENT_LABELS: Record<string, string> = {
  UNFULFILLED: "Niet verzonden",
  PARTIALLY_FULFILLED: "Deels verzonden",
  FULFILLED: "Verzonden",
  IN_PROGRESS: "In behandeling",
  ON_HOLD: "In de wacht",
  SCHEDULED: "Ingepland",
  PENDING_FULFILLMENT: "Wacht op verwerking",
  RESTOCKED: "Teruggeboekt",
  OPEN: "Open",
  REQUEST_DECLINED: "Verzoek geweigerd",
};

export function financialLabel(status: string | null): string {
  if (!status) return "—";
  return FINANCIAL_LABELS[status] ?? status;
}

export function financialTone(status: string | null) {
  return (status && FINANCIAL_TONE[status]) || "neutral";
}

export function fulfillmentLabel(status: string | null): string {
  if (!status) return "—";
  return FULFILLMENT_LABELS[status] ?? status;
}

const OPEN_PAYMENT = new Set(["PENDING", "PARTIALLY_PAID", "AUTHORIZED"]);
const NOT_YET_SHIPPED = new Set(["UNFULFILLED", "PARTIALLY_FULFILLED"]);
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export type OrderStatsInput = {
  legacyResourceId: string;
  createdAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
};

/** Counts over the orders on this page — never a claim about the whole shop.
 * "Actie nodig" is the existing logistics rule (needsAttention), nothing new. */
export function orderStats(
  orders: OrderStatsInput[],
  logistics: Map<string, OrderLogisticsSummary> | null,
  now: Date = new Date(),
): { recent: number; openPayment: number; toProcess: number; actionNeeded: number } {
  const live = orders.filter((o) => !o.cancelledAt);
  return {
    recent: live.filter((o) => now.getTime() - new Date(o.createdAt).getTime() <= RECENT_MS).length,
    openPayment: live.filter((o) => o.displayFinancialStatus && OPEN_PAYMENT.has(o.displayFinancialStatus)).length,
    toProcess: live.filter((o) => o.displayFulfillmentStatus && NOT_YET_SHIPPED.has(o.displayFulfillmentStatus)).length,
    actionNeeded: logistics
      ? live.filter((o) => {
          const item = logistics.get(o.legacyResourceId);
          return !!item && needsAttention(item);
        }).length
      : 0,
  };
}

/** The Afhandeling filter works on logistics data, which only exists for the
 * loaded page — so it narrows this page, it does not search Shopify. */
export function filterByHandoff<T extends { legacyResourceId: string }>(
  orders: T[],
  handoff: string,
  logistics: Map<string, OrderLogisticsSummary> | null,
): T[] {
  if (!handoff || !logistics) return orders;
  return orders.filter((o) => logistics.get(o.legacyResourceId)?.handoffType === handoff);
}
