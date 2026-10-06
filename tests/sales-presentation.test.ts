import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NAV_SECTIONS } from "@/components/layout/nav-config";
import {
  draftOrderDisplay,
  filterQuotes,
  parseQuoteSourceFilter,
  quoteStats,
  quoteStatusLabel,
  statusOptions,
  QUOTE_ACTION_LABELS,
  isNameOnlyQuoteTerm,
} from "@/modules/sales/quote-presentation";
import {
  buildOrderSearchQuery,
  filterByHandoff,
  financialLabel,
  fulfillmentLabel,
  orderStats,
  pickFilter,
  FINANCIAL_FILTERS,
} from "@/modules/sales/order-presentation";
import type { OrderLogisticsSummary } from "@/integrations/logistics/types";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf-8").replace(/\r\n/g, "\n");
}

describe("quote presentation", () => {
  const quotes = [
    { sourceSystem: "OFFERTEAPP" as const, status: "new" },
    { sourceSystem: "OFFERTEAPP" as const, status: "sent" },
    { sourceSystem: "S4U_QUOTE_APP" as const, status: "in_progress" },
    { sourceSystem: "S4U_QUOTE_APP" as const, status: "synced_draft_order" },
  ];

  it("translates known statuses and shows an unknown one as the source wrote it", () => {
    expect(quoteStatusLabel("new")).toBe("Nieuw");
    expect(quoteStatusLabel("in_progress")).toBe("In behandeling");
    expect(quoteStatusLabel("converted_to_order")).toBe("Order geworden");
    expect(quoteStatusLabel("synced_draft_order")).toBe("synced_draft_order");
    expect(quoteStatusLabel("")).toBe("Geen status");
  });

  it("filters the found set by source and status", () => {
    expect(filterQuotes(quotes, { source: "offerteapp", status: "" })).toHaveLength(2);
    expect(filterQuotes(quotes, { source: "webshop", status: "" })).toHaveLength(2);
    expect(filterQuotes(quotes, { source: "all", status: "sent" })).toEqual([quotes[1]]);
    expect(filterQuotes(quotes, { source: "webshop", status: "sent" })).toEqual([]);
    expect(parseQuoteSourceFilter("nonsense")).toBe("all");
  });

  it("counts only over the given set and offers only statuses that occur in it", () => {
    expect(quoteStats(quotes)).toEqual({ new: 1, inProgress: 1, sent: 1 });
    expect(statusOptions(quotes).map((o) => o.value).sort()).toEqual(["in_progress", "new", "sent", "synced_draft_order"]);
  });

  it("shows the draft order name, 'aanwezig' when only the GID is known, nothing without one", () => {
    const names = new Map([["gid://shopify/DraftOrder/570", "#D570"]]);
    expect(draftOrderDisplay("gid://shopify/DraftOrder/570", names)).toBe("#D570");
    expect(draftOrderDisplay("gid://shopify/DraftOrder/571", names)).toBe("aanwezig");
    expect(draftOrderDisplay(null, names)).toBeNull();
  });

  it("names the external app the action opens", () => {
    expect(QUOTE_ACTION_LABELS).toEqual({ OFFERTEAPP: "Openen in OfferteApp", S4U_QUOTE_APP: "Openen in Quote App" });
  });
});

describe("quote search — production regression (v32: 'verkoelen' showed an unexplained empty list)", () => {
  it("recognises a name, which no quote source can search on", () => {
    expect(isNameOnlyQuoteTerm("verkoelen")).toBe(true);
    expect(isNameOnlyQuoteTerm("  Van der Berg Bestrating BV ")).toBe(true);
  });

  it("never treats a quote number, year, e-mail or phone number as a name", () => {
    for (const term of ["2026", "OFF-2026-1006-006", "QR-20260930-00002", "klant@voorbeeld.nl", "+31 6 1234 5678", "0612345678"]) {
      expect(isNameOnlyQuoteTerm(term), term).toBe(false);
    }
    expect(isNameOnlyQuoteTerm("a")).toBe(false); // too short — the normal start state handles it
  });

  const page = source("src/app/(app)/quotes/page.tsx");

  it("does not query the sources for a name and says why, pointing to Klanten", () => {
    expect(page).toContain("const searched = !nameOnly && quoteSearchParams(term) !== null;");
    expect(page.indexOf("const nameOnly = isNameOnlyQuoteTerm(term);")).toBeLessThan(page.indexOf("loadQuotesOverview(term)"));
    expect(page).toContain('title="Zoeken op naam kan hier nog niet"');
    expect(page).toContain('href="/customers"');
  });

  it("when filters hide every result, says how many were found and offers 'Filters wissen'", () => {
    expect(page).toContain("gevonden, maar 0 voldoen aan de huidige filters");
    expect(page).toContain('href={`/quotes?q=${encodeURIComponent(term)}`}');
    expect(page).toContain("Filters wissen");
  });
});

describe("order presentation", () => {
  it("builds Shopify's own search string, so filtering and paging happen in Shopify", () => {
    expect(buildOrderSearchQuery({})).toBe("");
    expect(buildOrderSearchQuery({ term: "#1001" })).toBe("name:*1001*");
    expect(buildOrderSearchQuery({ term: 'x"\\y', financial: "paid", fulfillment: "unfulfilled" })).toBe(
      "name:*xy* financial_status:paid fulfillment_status:unfulfilled",
    );
    expect(buildOrderSearchQuery({ financial: "bogus" })).toBe("");
    expect(pickFilter(FINANCIAL_FILTERS, "paid")).toBe("paid");
    expect(pickFilter(FINANCIAL_FILTERS, "drop table")).toBe("");
  });

  it("translates financial and fulfillment status, raw value for anything unknown", () => {
    expect(financialLabel("PENDING")).toBe("Openstaand");
    expect(financialLabel("PAID")).toBe("Betaald");
    expect(financialLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(financialLabel(null)).toBe("—");
    expect(fulfillmentLabel("UNFULFILLED")).toBe("Niet verzonden");
    expect(fulfillmentLabel("PARTIALLY_FULFILLED")).toBe("Deels verzonden");
  });

  const now = new Date("2026-10-06T12:00:00Z");
  const orders = [
    { legacyResourceId: "1", createdAt: "2026-10-05T10:00:00Z", cancelledAt: null, displayFinancialStatus: "PENDING", displayFulfillmentStatus: "UNFULFILLED" },
    { legacyResourceId: "2", createdAt: "2026-09-01T10:00:00Z", cancelledAt: null, displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED" },
    { legacyResourceId: "3", createdAt: "2026-10-04T10:00:00Z", cancelledAt: "2026-10-04T11:00:00Z", displayFinancialStatus: "PENDING", displayFulfillmentStatus: "UNFULFILLED" },
  ];
  const logistic = (overrides: Partial<OrderLogisticsSummary>) =>
    ({
      shopifyOrderId: "1",
      handoffType: "VAN_EIJK",
      lock: { active: false },
      pick: { started: true, completed: false, pickedLines: 1, totalLines: 3 },
      pallets: { total: 0, scanned: 0 },
      ...overrides,
    }) as unknown as OrderLogisticsSummary;

  it("counts over the page, never cancelled orders, and uses the existing attention rule", () => {
    const logistics = new Map([["1", logistic({})], ["2", logistic({ shopifyOrderId: "2", handoffType: "HOEFNAGELS", pick: { started: true, completed: true, pickedLines: 3, totalLines: 3 } as never })]]);
    expect(orderStats(orders, logistics, now)).toEqual({ recent: 1, openPayment: 1, toProcess: 1, actionNeeded: 1 });
    expect(orderStats(orders, null, now).actionNeeded).toBe(0);
  });

  it("filters the page by handoff only when logistics data exists", () => {
    const logistics = new Map([["1", logistic({})], ["2", logistic({ shopifyOrderId: "2", handoffType: "HOEFNAGELS" })]]);
    expect(filterByHandoff(orders, "HOEFNAGELS", logistics).map((o) => o.legacyResourceId)).toEqual(["2"]);
    expect(filterByHandoff(orders, "", logistics)).toHaveLength(3);
    expect(filterByHandoff(orders, "VAN_EIJK", null)).toHaveLength(3);
  });
});

describe("navigation", () => {
  const items = NAV_SECTIONS.flatMap((s) => s.items.map((i) => ({ ...i, section: s.label })));
  const byLabel = (label: string) => items.find((i) => i.label === label)!;

  it("Offertes and Orders are real links now", () => {
    expect(byLabel("Offertes")).toMatchObject({ href: "/quotes" });
    expect(byLabel("Offertes").comingSoon).toBeFalsy();
    expect(byLabel("Orders")).toMatchObject({ href: "/orders" });
    expect(byLabel("Orders").comingSoon).toBeFalsy();
  });

  it("Operations and Service stay 'Binnenkort', and there is no separate Conceptorders item", () => {
    for (const label of ["Inkoop", "Productie", "Leveringen", "Service"]) {
      expect(byLabel(label).comingSoon).toBe(true);
      expect(byLabel(label).href).toBeUndefined();
    }
    expect(items.some((i) => /concept/i.test(i.label))).toBe(false);
  });
});

describe("pages", () => {
  const quotesPage = source("src/app/(app)/quotes/page.tsx");
  const ordersPage = source("src/app/(app)/orders/page.tsx");

  it("/quotes starts with a search, never a pretend-complete list, and says when results are capped", () => {
    expect(quotesPage).toContain('title="Zoek een offerte"');
    expect(quotesPage).toContain("Zoek op offertenummer, e-mailadres of telefoonnummer.");
    expect(quotesPage).toContain('data-testid="quotes-limit"');
    expect(quotesPage).toContain("Offertes tijdelijk niet beschikbaar");
    expect(quotesPage).toContain("?tab=orders");
  });

  it("/orders stacks rows on mobile instead of a wide table, and keeps unavailable ≠ no data", () => {
    expect(ordersPage).toMatch(/<ul className="cc-card divide-y divide-border-subtle md:hidden">/);
    expect(ordersPage).toMatch(/<div className="hidden md:block">/);
    expect(ordersPage).toContain('unavailable ? "Niet beschikbaar" : "—"');
    expect(ordersPage).toContain("Shopify is niet bereikbaar");
    expect(ordersPage).toContain("/orders/${row.legacyResourceId}");
  });

  it("both pages stay read-only — no forms that post, no mutation calls", () => {
    for (const page of [quotesPage, ordersPage]) {
      expect(page).not.toMatch(/method="post"|fetch\(|mutation/i);
    }
  });
});
