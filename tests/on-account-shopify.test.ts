import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Op rekening v1 — Shopify layer against a mocked fetch (same technique as
// tests/fulfillment-mode-write.test.ts). Proves: the write guard runs before
// EVERY mutation and blocks it, the exact mutation inputs, and how each
// Shopify answer is classified.

const ENV_KEYS = ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_API_VERSION", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS"] as const;
const ORDER = "gid://shopify/Order/9001";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const token = () => json({ access_token: "tok", expires_in: 3600 });
const shop = (domain = "stones4u-dev.myshopify.com") => json({ data: { shop: { myshopifyDomain: domain } } });
const fixedTemplate = () => json({ data: { paymentTermsTemplates: [{ id: "gid://shopify/PaymentTermsTemplate/7", paymentTermsType: "FIXED" }] } });

function env(allowed: string | null = "stones4u-dev.myshopify.com") {
  process.env.SHOPIFY_SHOP_DOMAIN = "stones4u-dev.myshopify.com";
  process.env.SHOPIFY_API_VERSION = "2026-07";
  process.env.SHOPIFY_CLIENT_ID = "id";
  process.env.SHOPIFY_CLIENT_SECRET = "secret";
  if (allowed) process.env.SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS = allowed;
}

function bodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .map((c) => (c[1] as RequestInit | undefined)?.body)
    .filter((b): b is string => typeof b === "string" && b.startsWith("{"))
    .map((b) => JSON.parse(b) as { query: string; variables?: Record<string, unknown> });
}

async function load() {
  const read = await import("@/integrations/shopify/on-account-read");
  read.__resetOnAccountTemplateCacheForTests();
  const write = await import("@/integrations/shopify/on-account");
  return { ...read, ...write };
}

describe("on-account Shopify layer", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });
  afterEach(() => vi.unstubAllGlobals());

  it("blocks every mutation when no write allowlist is configured — nothing is sent", async () => {
    env(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const m = await load();
    await expect(m.createFixedPaymentTerms(ORDER, new Date("2026-11-19T22:59:59Z"))).rejects.toThrow(/SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS/);
    await expect(m.sendOrderInvoice(ORDER, "a@example.com", "x")).rejects.toThrow();
    await expect(m.deleteOrderPaymentTerms("gid://shopify/PaymentTerms/1")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a mutation against a shop that is not on the allowlist (production identity)", async () => {
    env("stones4u-dev.myshopify.com");
    const fetchMock = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(shop("9h7x2c-ku.myshopify.com"));
    vi.stubGlobal("fetch", fetchMock);
    const m = await load();
    await expect(m.sendOrderInvoice(ORDER, "a@example.com", "x")).rejects.toThrow();
    expect(bodies(fetchMock).some((b) => /orderInvoiceSend/.test(b.query))).toBe(false);
  });

  it("creates FIXED terms with exactly one schedule and the given dueAt", async () => {
    env();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(shop())
      .mockResolvedValueOnce(fixedTemplate())
      .mockResolvedValueOnce(json({ data: { paymentTermsCreate: { paymentTerms: { id: "gid://shopify/PaymentTerms/55", paymentTermsType: "FIXED", paymentSchedules: { nodes: [{ id: "s", dueAt: "2026-11-19T22:59:59Z" }] } }, userErrors: [] } } }));
    vi.stubGlobal("fetch", fetchMock);
    const m = await load();
    const r = await m.createFixedPaymentTerms(ORDER, new Date("2026-11-19T22:59:59Z"));
    expect(r).toEqual({ paymentTermsId: "gid://shopify/PaymentTerms/55", dueAt: "2026-11-19T22:59:59Z" });
    const create = bodies(fetchMock).find((b) => /paymentTermsCreate/.test(b.query))!;
    expect(create.variables).toEqual({
      ref: ORDER,
      attrs: { paymentTermsTemplateId: "gid://shopify/PaymentTermsTemplate/7", paymentSchedules: [{ dueAt: "2026-11-19T22:59:59.000Z" }] },
    });
  });

  it("classifies delete: DELETED, ALREADY_GONE, other userErrors throw", async () => {
    env();
    const del = (deletedId: string | null, msg?: string) =>
      json({ data: { paymentTermsDelete: { deletedId, userErrors: msg ? [{ field: null, message: msg, code: "PAYMENT_TERMS_DELETE_UNSUCCESSFUL" }] : [] } } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(shop())
      .mockResolvedValueOnce(del("gid://shopify/PaymentTerms/1"))
      .mockResolvedValueOnce(shop())
      .mockResolvedValueOnce(del(null, "Could not find payment terms."))
      .mockResolvedValueOnce(shop())
      .mockResolvedValueOnce(del(null, "Something else"));
    vi.stubGlobal("fetch", fetchMock);
    const m = await load();
    expect(await m.deleteOrderPaymentTerms("gid://shopify/PaymentTerms/1")).toEqual({ outcome: "DELETED" });
    expect(await m.deleteOrderPaymentTerms("gid://shopify/PaymentTerms/1")).toEqual({ outcome: "ALREADY_GONE" });
    await expect(m.deleteOrderPaymentTerms("gid://shopify/PaymentTerms/1")).rejects.toThrow(/Something else/);
  });

  it("invoice: SENT vs NOT_SENT (userErrors = definitely no mail); recipient + message are passed through", async () => {
    env();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(shop())
      .mockResolvedValueOnce(json({ data: { orderInvoiceSend: { order: { id: ORDER }, userErrors: [] } } }))
      .mockResolvedValueOnce(shop())
      .mockResolvedValueOnce(json({ data: { orderInvoiceSend: { order: null, userErrors: [{ field: null, message: "No outstanding balance exist", code: "ORDER_INVOICE_SEND_UNSUCCESSFUL" }] } } }));
    vi.stubGlobal("fetch", fetchMock);
    const m = await load();
    expect(await m.sendOrderInvoice(ORDER, "klant@example.com", "Betaaltermijn: 30 dagen")).toEqual({ outcome: "SENT" });
    const second = await m.sendOrderInvoice(ORDER, "klant@example.com", "x");
    expect(second.outcome).toBe("NOT_SENT");
    const send = bodies(fetchMock).find((b) => /orderInvoiceSend/.test(b.query))!;
    expect(send.variables).toEqual({ id: ORDER, email: { to: "klant@example.com", customMessage: "Betaaltermijn: 30 dagen" } });
  });

  it("a network failure or 5xx during the invoice send is thrown ONCE (outcome unknown) — never retried, never NOT_SENT", async () => {
    env();
    const fetchMock = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(shop()).mockRejectedValueOnce(new Error("socket hang up"));
    vi.stubGlobal("fetch", fetchMock);
    const m = await load();
    await expect(m.sendOrderInvoice(ORDER, "k@example.com", "x")).rejects.toThrow();
    expect(fetchMock.mock.calls.filter((c) => String((c[1] as RequestInit)?.body ?? "").includes("orderInvoiceSend"))).toHaveLength(1);

    const fetch5xx = vi.fn().mockResolvedValueOnce(shop()).mockResolvedValueOnce(json({ errors: [{ message: "Internal" }] }, 502));
    vi.stubGlobal("fetch", fetch5xx);
    await expect(m.sendOrderInvoice(ORDER, "k@example.com", "x")).rejects.toThrow();
    expect(fetch5xx.mock.calls.filter((c) => String((c[1] as RequestInit)?.body ?? "").includes("orderInvoiceSend"))).toHaveLength(1);
  });

  it("a 429 on the invoice send IS retried (Shopify did not execute it)", async () => {
    env();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(shop())
      .mockResolvedValueOnce(json({ errors: [{ message: "Throttled" }] }, 429))
      .mockResolvedValueOnce(json({ data: { orderInvoiceSend: { order: { id: ORDER }, userErrors: [] } } }));
    vi.stubGlobal("fetch", fetchMock);
    const m = await load();
    expect(await m.sendOrderInvoice(ORDER, "k@example.com", "x")).toEqual({ outcome: "SENT" });
  });

  it("maps an order read: metafields, attributes, terms and only the 'sent invoice' events", async () => {
    env();
    const fetchMock = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(
      json({
        data: {
          order: {
            id: ORDER, name: "#9001", createdAt: "2026-10-20T10:00:00Z", tags: ["op-rekening"], cancelledAt: null,
            displayFinancialStatus: "PENDING", displayFulfillmentStatus: "UNFULFILLED", email: "k@example.com", app: { name: "Source2POS" },
            customer: { id: "gid://shopify/Customer/1", defaultEmailAddress: { emailAddress: "k@example.com" } },
            totalPriceSet: { shopMoney: { amount: "48.4" } }, totalOutstandingSet: { shopMoney: { amount: "48.4" } },
            customAttributes: [{ key: "_stones4u_payment_term_days", value: "45" }, { key: "other", value: "x" }],
            termDays: { value: "45" }, handedOverAt: null, invoiceSentAt: null,
            paymentTerms: { id: "gid://shopify/PaymentTerms/9", paymentTermsType: "FULFILLMENT", paymentTermsName: "Due on fulfillment", overdue: false, paymentSchedules: { nodes: [] } },
            events: { nodes: [{ createdAt: "2026-10-20T11:00:00Z", message: "CRM sent invoice #9001 to <b>K</b>" }, { createdAt: "2026-10-20T10:00:00Z", message: "Order created" }] },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const m = await load();
    const o = (await m.readOnAccountOrder(ORDER))!;
    expect(o.metafields.termDays).toBe("45");
    expect(o.attributes).toEqual({ termDays: "45", handedOverAt: null });
    expect(o.paymentTerms?.type).toBe("FULFILLMENT");
    expect(o.invoiceEvents).toEqual([{ createdAt: "2026-10-20T11:00:00Z", message: "CRM sent invoice #9001 to K" }]);
  });

  it("customer credit write: set both, or clear the term (metafieldsDelete)", async () => {
    env();
    const ok = () => json({ data: { metafieldsSet: { metafields: [], userErrors: [] } } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(shop())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(shop())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(json({ data: { metafieldsDelete: { deletedMetafields: [{ key: "payment_term_days" }], userErrors: [] } } }));
    vi.stubGlobal("fetch", fetchMock);
    const m = await load();
    await m.writeCustomerCredit("gid://shopify/Customer/1", { creditAllowed: true, termDays: 45 });
    await m.writeCustomerCredit("gid://shopify/Customer/1", { creditAllowed: true, termDays: null });
    const b = bodies(fetchMock);
    const sets = b.filter((x) => /metafieldsSet/.test(x.query));
    expect((sets[0]!.variables!.metafields as unknown[]).length).toBe(2);
    expect((sets[1]!.variables!.metafields as unknown[]).length).toBe(1);
    expect(b.some((x) => /metafieldsDelete/.test(x.query))).toBe(true);
  });
});
