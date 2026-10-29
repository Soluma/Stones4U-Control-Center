import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanLineWorkValue, parseLineWork } from "@/integrations/shopify/line-work";

describe("parseLineWork — Werk / Referentie per order line", () => {
  it("reads exactly the two contract keys", () => {
    expect(
      parseLineWork([
        { key: "_s2p_cart_line_id", value: "clx123" },
        { key: "Werk", value: "Project Venlo" },
        { key: "Referentie", value: "PROJECT-2026-184" },
      ]),
    ).toEqual({ werk: "Project Venlo", referentie: "PROJECT-2026-184" });
  });

  it("is case-sensitive and ignores look-alike keys", () => {
    expect(
      parseLineWork([
        { key: "werk", value: "x" },
        { key: "WERK", value: "x" },
        { key: "Project", value: "x" },
        { key: "stones4u_work", value: "x" },
        { key: "referentie", value: "x" },
      ]),
    ).toEqual({ werk: null, referentie: null });
  });

  it("treats a missing, null or empty list as no Werk", () => {
    expect(parseLineWork(undefined)).toEqual({ werk: null, referentie: null });
    expect(parseLineWork(null)).toEqual({ werk: null, referentie: null });
    expect(parseLineWork([])).toEqual({ werk: null, referentie: null });
  });

  it("treats empty and whitespace-only values as absent", () => {
    expect(parseLineWork([{ key: "Werk", value: "" }, { key: "Referentie", value: "   " }])).toEqual({
      werk: null,
      referentie: null,
    });
    expect(parseLineWork([{ key: "Werk", value: null }])).toEqual({ werk: null, referentie: null });
  });

  it("uses the first attribute when a key appears twice", () => {
    expect(parseLineWork([{ key: "Werk", value: "Eerste" }, { key: "Werk", value: "Tweede" }]).werk).toBe("Eerste");
  });

  it("trims, collapses whitespace and drops control characters on read", () => {
    expect(cleanLineWorkValue("  Project   A  ")).toBe("Project A");
    expect(cleanLineWorkValue("Project\nA\r\n\tfase 2")).toBe("Project A fase 2");
    expect(cleanLineWorkValue("a\u0000b\u007Fc")).toBe("a b c");
  });

  it("keeps unicode and punctuation as typed — escaping is the renderer's job", () => {
    expect(cleanLineWorkValue("Appartementen Maasboulevard – fase 2 (Venlo) & co, café")).toBe(
      "Appartementen Maasboulevard – fase 2 (Venlo) & co, café",
    );
    // Not stripped here: React escapes it on output, so it shows as text.
    expect(cleanLineWorkValue("<b>x</b>")).toBe("<b>x</b>");
  });
});

const ENV_KEYS = ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_API_VERSION", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"] as const;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function orderNode(lines: unknown[]) {
  return {
    data: {
      order: {
        id: "gid://shopify/Order/1167",
        legacyResourceId: "1167",
        name: "#1167",
        createdAt: "2026-10-29T10:00:00Z",
        cancelledAt: null,
        note: null,
        displayFinancialStatus: "PENDING",
        displayFulfillmentStatus: "UNFULFILLED",
        currentTotalPriceSet: { shopMoney: { amount: "103.57", currencyCode: "EUR" } },
        customer: null,
        lineItems: { pageInfo: { hasNextPage: false }, edges: lines.map((node) => ({ node })) },
      },
    },
  };
}

describe("getShopifyOrderDetail reads Werk / Referentie from the Shopify line items", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.SHOPIFY_SHOP_DOMAIN = "test-shop.myshopify.com";
    process.env.SHOPIFY_API_VERSION = "2026-07";
    process.env.SHOPIFY_CLIENT_ID = "test-client-id";
    process.env.SHOPIFY_CLIENT_SECRET = "test-client-secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("selects line customAttributes and maps them per line, without mixing lines up", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: "tok_123", expires_in: 3600 }))
      .mockResolvedValueOnce(
        jsonResponse(
          orderNode([
            {
              id: "gid://shopify/LineItem/1",
              title: "BKK Oud Bont 7cm",
              variantTitle: null,
              sku: "BKK7",
              quantity: 2,
              currentQuantity: 2,
              customAttributes: [
                { key: "Werk", value: "Project A" },
                { key: "Referentie", value: "PROJECT-2026-184" },
              ],
            },
            {
              id: "gid://shopify/LineItem/2",
              title: "BKK Oud Bont 7cm",
              variantTitle: null,
              sku: "BKK7",
              quantity: 1,
              currentQuantity: 1,
              customAttributes: [{ key: "Werk", value: "Project B" }],
            },
            {
              id: "gid://shopify/LineItem/3",
              title: "BKK Oud Bont 7cm",
              variantTitle: null,
              sku: "BKK7",
              quantity: 1,
              currentQuantity: 1,
              customAttributes: [],
            },
          ]),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { getShopifyOrderDetail } = await import("@/integrations/shopify/order-detail");
    const order = await getShopifyOrderDetail("gid://shopify/Order/1167");

    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(request.body as string) as { query: string };
    expect(body.query).toMatch(/customAttributes\s*\{\s*key\s+value\s*\}/);
    expect(body.query).not.toMatch(/mutation/);

    expect(order?.lineItems.map(({ gid, werk, referentie, quantity }) => ({ gid, werk, referentie, quantity }))).toEqual([
      { gid: "gid://shopify/LineItem/1", werk: "Project A", referentie: "PROJECT-2026-184", quantity: 2 },
      { gid: "gid://shopify/LineItem/2", werk: "Project B", referentie: null, quantity: 1 },
      { gid: "gid://shopify/LineItem/3", werk: null, referentie: null, quantity: 1 },
    ]);
  });
});

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf-8");
}

describe("the order page shows its lines from Shopify alone", () => {
  const ORDER_DIR = "src/app/(app)/customers/[id]/orders/[orderId]";

  it("renders the order-lines block outside the OfferteApp logistics result", () => {
    const page = read(`${ORDER_DIR}/page.tsx`).replace(/\s+/g, " ");
    expect(page).toContain("<OrderLinesSection lines={order.lineItems}");
    // Not inside a `logistics.ok ? … : …` branch: the block is a sibling of
    // the warehouse section and only receives the Shopify order.
    const block = page.slice(page.indexOf("<OrderLinesSection"), page.indexOf("/>", page.indexOf("<OrderLinesSection")));
    expect(block).not.toContain("logistics");
    const section = read(`${ORDER_DIR}/OrderLinesSection.tsx`);
    expect(section).not.toContain("LogisticsDetailResult");
    expect(section).not.toContain("@/integrations/logistics");
    expect(section).toContain("<LineWorkDetails line={line} />");
  });

  it("labels the two fields exactly and renders nothing when both are empty", () => {
    const details = read(`${ORDER_DIR}/LineWorkDetails.tsx`);
    expect(details).toContain("Werk:");
    expect(details).toContain("Referentie:");
    expect(details).toContain("if (!line.werk && !line.referentie) return null;");
    expect(details).not.toContain("dangerouslySetInnerHTML");
  });

  it("also shows Werk / Referentie on the pick lines", () => {
    const warehouse = read(`${ORDER_DIR}/WarehouseLogisticsSection.tsx`);
    expect(warehouse.match(/<LineWorkDetails line=\{shopifyLine\} \/>/g)).toHaveLength(2);
  });
});
