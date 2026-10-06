import { beforeEach, describe, expect, it, vi } from "vitest";

// Server-side loading for /quotes and /orders: exact customer resolution
// (never fuzzy), one batch per external system, fail-soft logistics.

const findMany = vi.fn();
vi.mock("@/platform/db/prisma", () => ({ prisma: { customerProfile: { findMany: (...a: unknown[]) => findMany(...a) } } }));

const listQuotes = vi.fn();
const listQuotesForResolvedCustomer = vi.fn();
vi.mock("@/integrations/quotes/adapter", () => ({ createQuotesAdapter: () => ({ listQuotes, listQuotesForResolvedCustomer }) }));

const searchCustomers = vi.fn();
vi.mock("@/modules/crm/customer-profile.service", () => ({ searchCustomers: (...a: unknown[]) => searchCustomers(...a) }));

const getDraftOrderNames = vi.fn();
vi.mock("@/integrations/shopify/draft-orders", () => ({ getDraftOrderNames: (...a: unknown[]) => getDraftOrderNames(...a) }));

const listShopifyOrders = vi.fn();
vi.mock("@/integrations/shopify/orders", () => ({ listShopifyOrders: (...a: unknown[]) => listShopifyOrders(...a), ORDERS_PAGE_SIZE: 50 }));

const getForOrders = vi.fn();
let logisticsAvailable = true;
vi.mock("@/integrations/logistics/adapter", () => ({
  createLogisticsAdapter: () => ({
    status: () => (logisticsAvailable ? { available: true } : { available: false, reason: "x" }),
    getForOrders: (...a: unknown[]) => getForOrders(...a),
  }),
}));

function profile(overrides: Record<string, unknown>) {
  return { id: "p1", shopifyCustomerGid: "gid://shopify/Customer/1", email: null, displayName: "Jan Jansen", companyName: null, customerTypeOverride: null, ...overrides };
}

function q(overrides: Record<string, unknown>) {
  return {
    externalId: "q",
    displayNumber: "OFF-1",
    email: null,
    phone: null,
    shopifyCustomerGid: null,
    shopifyDraftOrderGid: null,
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-01T10:00:00Z",
    status: "new",
    total: "10",
    currency: "EUR",
    sourceSystem: "OFFERTEAPP",
    adminUrl: "https://x/overzichten",
    ...overrides,
  };
}

function order(i: number, overrides: Record<string, unknown> = {}) {
  return {
    gid: `gid://shopify/Order/${1000 + i}`,
    legacyResourceId: String(1000 + i),
    name: `#${1000 + i}`,
    createdAt: "2026-10-01T10:00:00Z",
    cancelledAt: null,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    currentTotalPriceSet: { amount: "10.00", currencyCode: "EUR" },
    customer: { gid: `gid://shopify/Customer/${i}`, displayName: `Klant ${i}` },
    adminUrl: `https://admin.shopify.com/store/x/orders/${1000 + i}`,
    ...overrides,
  };
}

const PAGE_INFO = { hasNextPage: true, hasPreviousPage: false, startCursor: "s", endCursor: "e" };

beforeEach(() => {
  vi.resetModules();
  findMany.mockReset();
  listQuotes.mockReset();
  listQuotesForResolvedCustomer.mockReset();
  searchCustomers.mockReset();
  getDraftOrderNames.mockReset().mockResolvedValue(new Map());
  listShopifyOrders.mockReset();
  getForOrders.mockReset();
  logisticsAvailable = true;
});

describe("loadQuotesOverview — customer resolution", () => {
  const sources = { OFFERTEAPP: "ok", S4U_QUOTE_APP: "ok" };
  const limitReached = { OFFERTEAPP: false, S4U_QUOTE_APP: false };

  it("resolves by Shopify Customer GID first, then by exact e-mail, else no customer", async () => {
    listQuotes.mockResolvedValue({
      sources,
      limitReached,
      quotes: [
        q({ externalId: "a", shopifyCustomerGid: "gid://shopify/Customer/1", email: "other@x.nl" }),
        q({ externalId: "b", email: "Piet@Voorbeeld.nl" }),
        q({ externalId: "c", email: "onbekend@voorbeeld.nl", phone: "0612345678" }),
      ],
    });
    findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      "shopifyCustomerGid" in where
        ? [profile({ id: "p-gid" })]
        : [profile({ id: "p-mail", shopifyCustomerGid: "gid://shopify/Customer/2", email: "piet@voorbeeld.nl", displayName: "Piet" })],
    );
    const { loadQuotesOverview } = await import("@/modules/sales/sales-overview");
    const result = await loadQuotesOverview("voorbeeld");
    const byId = Object.fromEntries(result.rows.map((r) => [r.externalId, r.customer?.id ?? null]));
    expect(byId).toEqual({ a: "p-gid", b: "p-mail", c: null });
    // exactly two DB queries (GID batch + e-mail batch), never one per quote
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("never links an e-mail shared by two profiles, and never matches on name", async () => {
    listQuotes.mockResolvedValue({ sources, limitReached, quotes: [q({ externalId: "a", email: "gedeeld@voorbeeld.nl" })] });
    findMany.mockResolvedValue([
      profile({ id: "p1", email: "gedeeld@voorbeeld.nl" }),
      profile({ id: "p2", shopifyCustomerGid: "gid://shopify/Customer/9", email: "GEDEELD@voorbeeld.nl" }),
    ]);
    const { loadQuotesOverview } = await import("@/modules/sales/sales-overview");
    const result = await loadQuotesOverview("gedeeld@voorbeeld.nl");
    expect(result.rows[0]!.customer).toBeNull();
    const where = JSON.stringify(findMany.mock.calls.map((c) => (c[0] as { where: unknown }).where));
    expect(where).not.toMatch(/contains|displayName|search/);
  });

  it("looks up all draft-order names in one call", async () => {
    listQuotes.mockResolvedValue({
      sources,
      limitReached,
      quotes: [q({ externalId: "a", shopifyDraftOrderGid: "gid://shopify/DraftOrder/1" }), q({ externalId: "b", shopifyDraftOrderGid: "gid://shopify/DraftOrder/2" }), q({ externalId: "c" })],
    });
    findMany.mockResolvedValue([]);
    getDraftOrderNames.mockResolvedValue(new Map([["gid://shopify/DraftOrder/1", "#D1"]]));
    const { loadQuotesOverview } = await import("@/modules/sales/sales-overview");
    const result = await loadQuotesOverview("OFF");
    expect(getDraftOrderNames).toHaveBeenCalledTimes(1);
    expect(getDraftOrderNames.mock.calls[0]![0]).toEqual(["gid://shopify/DraftOrder/1", "gid://shopify/DraftOrder/2"]);
    expect(result.draftOrderNames.get("gid://shopify/DraftOrder/1")).toBe("#D1");
  });
});

describe("loadOrdersOverview", () => {
  it("loads one Shopify page, one customer query and one logistics batch for all visible orders", async () => {
    const orders = Array.from({ length: 50 }, (_, i) => order(i));
    listShopifyOrders.mockResolvedValue({ orders, pageInfo: PAGE_INFO });
    findMany.mockResolvedValue([profile({ id: "p-3", shopifyCustomerGid: "gid://shopify/Customer/3" })]);
    getForOrders.mockResolvedValue({ ok: true, byOrderId: new Map(), notFound: [], partial: false });
    const { loadOrdersOverview } = await import("@/modules/sales/sales-overview");

    const result = await loadOrdersOverview({ term: "1001", financial: "pending", after: "cursor-1" });

    expect(listShopifyOrders).toHaveBeenCalledTimes(1);
    expect(listShopifyOrders.mock.calls[0]![0]).toEqual({ query: "name:*1001* financial_status:pending", after: "cursor-1", before: undefined });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(getForOrders).toHaveBeenCalledTimes(1);
    expect(getForOrders.mock.calls[0]![0]).toHaveLength(50);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.find((r) => r.legacyResourceId === "1003")!.customerProfile).toEqual({ id: "p-3", name: "Jan Jansen" });
    expect(result.rows.find((r) => r.legacyResourceId === "1004")!.customerProfile).toBeNull();
    expect(result.logistics).toEqual({ byOrderId: new Map(), unavailable: false, notConfigured: false });
  });

  it("keeps showing Shopify orders when OfferteApp is down — logistics reads as unavailable, not empty", async () => {
    listShopifyOrders.mockResolvedValue({ orders: [order(1)], pageInfo: PAGE_INFO });
    findMany.mockResolvedValue([]);
    getForOrders.mockResolvedValue({ ok: false, reason: "failed" });
    const { loadOrdersOverview } = await import("@/modules/sales/sales-overview");
    const result = await loadOrdersOverview({});
    expect(result.ok && result.rows).toHaveLength(1);
    expect(result.ok && result.logistics.unavailable).toBe(true);
  });

  it("treats a thrown logistics error and a partial batch as unavailable too", async () => {
    listShopifyOrders.mockResolvedValue({ orders: [order(1)], pageInfo: PAGE_INFO });
    findMany.mockResolvedValue([]);
    getForOrders.mockRejectedValueOnce(new Error("boom"));
    const { loadOrdersOverview } = await import("@/modules/sales/sales-overview");
    expect((await loadOrdersOverview({})).ok && true).toBe(true);
    getForOrders.mockResolvedValueOnce({ ok: true, byOrderId: new Map(), notFound: [], partial: true });
    const partial = await loadOrdersOverview({});
    expect(partial.ok && partial.logistics.unavailable).toBe(true);
  });

  it("does not call OfferteApp at all when it is not configured", async () => {
    logisticsAvailable = false;
    listShopifyOrders.mockResolvedValue({ orders: [order(1)], pageInfo: PAGE_INFO });
    findMany.mockResolvedValue([]);
    const { loadOrdersOverview } = await import("@/modules/sales/sales-overview");
    const result = await loadOrdersOverview({});
    expect(getForOrders).not.toHaveBeenCalled();
    expect(result.ok && result.logistics.notConfigured).toBe(true);
  });

  it("works for an order without a Shopify customer", async () => {
    listShopifyOrders.mockResolvedValue({ orders: [order(1, { customer: null })], pageInfo: PAGE_INFO });
    getForOrders.mockResolvedValue({ ok: true, byOrderId: new Map(), notFound: [], partial: false });
    const { loadOrdersOverview } = await import("@/modules/sales/sales-overview");
    const result = await loadOrdersOverview({});
    expect(findMany).not.toHaveBeenCalled();
    expect(result.ok && result.rows[0]!.customerProfile).toBeNull();
  });

  it("returns ok:false when Shopify fails, instead of throwing", async () => {
    listShopifyOrders.mockRejectedValue(new Error("Shopify 503"));
    const { loadOrdersOverview } = await import("@/modules/sales/sales-overview");
    expect(await loadOrdersOverview({})).toEqual({ ok: false });
    expect(getForOrders).not.toHaveBeenCalled();
  });
});

function shopifyCustomer(legacyId: string, overrides: Record<string, unknown> = {}) {
  return {
    shopify: {
      gid: `gid://shopify/Customer/${legacyId}`,
      legacyId,
      displayName: `Klant ${legacyId}`,
      firstName: null,
      lastName: null,
      email: `klant${legacyId}@voorbeeld.nl`,
      phone: `+3161234${legacyId}`,
      company: null,
      defaultAddressSummary: "Eindhoven",
      numberOfOrders: 1,
      amountSpent: null,
      ...overrides,
    },
    customerProfileId: null,
  };
}

const OK = { sources: { OFFERTEAPP: "ok", S4U_QUOTE_APP: "ok" }, limitReached: { OFFERTEAPP: false, S4U_QUOTE_APP: false } };

describe("searchQuotesOverview — name search via the Shopify customer search", () => {
  it("a name with exactly one Shopify customer: searchCustomers, then both sources on that customer's hard identifiers", async () => {
    searchCustomers.mockResolvedValue([shopifyCustomer("901")]);
    listQuotesForResolvedCustomer.mockResolvedValue({ ...OK, quotes: [q({ externalId: "a" }), q({ externalId: "b", sourceSystem: "S4U_QUOTE_APP" })] });
    findMany.mockResolvedValue([]);
    const { searchQuotesOverview } = await import("@/modules/sales/sales-overview");

    const out = await searchQuotesOverview("verkoelen");

    expect(searchCustomers).toHaveBeenCalledWith("verkoelen");
    expect(listQuotes).not.toHaveBeenCalled(); // the name never reaches a quote source
    expect(listQuotesForResolvedCustomer).toHaveBeenCalledTimes(1);
    expect(listQuotesForResolvedCustomer).toHaveBeenCalledWith({ legacyId: "901", email: "klant901@voorbeeld.nl", phone: "+31612349" + "01" });
    expect(out.kind).toBe("quotes");
    if (out.kind !== "quotes") return;
    expect(out.overview.rows.map((r) => r.externalId)).toEqual(["a", "b"]);
    expect(out.customer).toMatchObject({ legacyId: "901", displayName: "Klant 901" });
  });

  it("a company name behaves the same and shows the company", async () => {
    searchCustomers.mockResolvedValue([shopifyCustomer("902", { company: "Jansen Tuinen BV" })]);
    listQuotesForResolvedCustomer.mockResolvedValue({ ...OK, quotes: [] });
    const { searchQuotesOverview } = await import("@/modules/sales/sales-overview");
    const out = await searchQuotesOverview("Jansen Tuinen");
    expect(out.kind === "quotes" && out.customer?.company).toBe("Jansen Tuinen BV");
    expect(listQuotesForResolvedCustomer).toHaveBeenCalledTimes(1);
  });

  it("no customer: a clear outcome and zero quote requests", async () => {
    searchCustomers.mockResolvedValue([]);
    const { searchQuotesOverview } = await import("@/modules/sales/sales-overview");
    expect(await searchQuotesOverview("bestaatniet")).toEqual({ kind: "no_customer" });
    expect(listQuotes).not.toHaveBeenCalled();
    expect(listQuotesForResolvedCustomer).not.toHaveBeenCalled();
  });

  it("several customers: a choice first, zero quote requests before one is picked", async () => {
    searchCustomers.mockResolvedValue([shopifyCustomer("11"), shopifyCustomer("12", { company: "Jansen Tuinen BV" })]);
    const { searchQuotesOverview } = await import("@/modules/sales/sales-overview");
    const out = await searchQuotesOverview("jansen");
    expect(out.kind).toBe("choose_customer");
    expect(out.kind === "choose_customer" && out.customers.map((c) => c.legacyId)).toEqual(["11", "12"]);
    expect(listQuotes).not.toHaveBeenCalled();
    expect(listQuotesForResolvedCustomer).not.toHaveBeenCalled();
  });

  it("a picked customer: only that customer's identifiers, re-read from Shopify", async () => {
    searchCustomers.mockResolvedValue([shopifyCustomer("11"), shopifyCustomer("12")]);
    listQuotesForResolvedCustomer.mockResolvedValue({ ...OK, quotes: [] });
    const { searchQuotesOverview } = await import("@/modules/sales/sales-overview");
    const out = await searchQuotesOverview("jansen", "12");
    expect(listQuotesForResolvedCustomer).toHaveBeenCalledWith({ legacyId: "12", email: "klant12@voorbeeld.nl", phone: "+3161234" + "12" });
    expect(out.kind === "quotes" && out.customerCount).toBe(2);
  });

  it("a manipulated customer parameter is not trusted: no quote request, the choice again with a notice", async () => {
    searchCustomers.mockResolvedValue([shopifyCustomer("11"), shopifyCustomer("12")]);
    const { searchQuotesOverview } = await import("@/modules/sales/sales-overview");
    for (const forged of ["999", "11 OR 1=1", "../12", "klant12@voorbeeld.nl"]) {
      const out = await searchQuotesOverview("jansen", forged);
      expect(out).toMatchObject({ kind: "choose_customer", invalidSelection: true });
    }
    expect(listQuotesForResolvedCustomer).not.toHaveBeenCalled();
  });

  it("a forged customer with a single real match still does not silently switch customers", async () => {
    searchCustomers.mockResolvedValue([shopifyCustomer("11")]);
    const { searchQuotesOverview } = await import("@/modules/sales/sales-overview");
    expect(await searchQuotesOverview("verkoelen", "999")).toMatchObject({ kind: "choose_customer", invalidSelection: true });
    expect(listQuotesForResolvedCustomer).not.toHaveBeenCalled();
  });

  it("Shopify customer search failing is reported, not thrown", async () => {
    searchCustomers.mockRejectedValue(new Error("Shopify 503"));
    const { searchQuotesOverview } = await import("@/modules/sales/sales-overview");
    expect(await searchQuotesOverview("verkoelen")).toEqual({ kind: "customer_search_failed" });
  });

  it("numbers, quote numbers, e-mail and phone never trigger a customer search", async () => {
    listQuotes.mockResolvedValue({ ...OK, quotes: [q({ externalId: "a" })] });
    findMany.mockResolvedValue([]);
    const { searchQuotesOverview } = await import("@/modules/sales/sales-overview");
    for (const term of ["2026", "OFF-2026-1006-006", "klant@voorbeeld.nl", "0612345678"]) {
      const out = await searchQuotesOverview(term);
      expect(out.kind, term).toBe("quotes");
      expect(listQuotes).toHaveBeenLastCalledWith({ mode: "search", term });
    }
    expect(searchCustomers).not.toHaveBeenCalled();
    expect(listQuotesForResolvedCustomer).not.toHaveBeenCalled();
  });
});
