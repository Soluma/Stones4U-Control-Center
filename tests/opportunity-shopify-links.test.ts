import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { createTestUser, cleanupUser } from "./fixtures";

// Pre-production review finding E/6 — OpportunityExternalLink must verify
// a SHOPIFY_ORDER/SHOPIFY_DRAFT_ORDER externalRef actually belongs to the
// opportunity's own customer before storing the link, using the existing
// Shopify read adapters (no new Shopify integration surface). Mirrors the
// mocking pattern already established in tests/shopify-draft-orders.test.ts —
// vi.resetModules() + dynamic import per test so each test gets a fresh,
// uncached Shopify client (no in-memory OAuth token bleeding between
// tests) and a fresh copy of opportunity.service.ts bound to it.

const ENV_KEYS = ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_API_VERSION", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"] as const;

function setShopifyEnv() {
  process.env.SHOPIFY_SHOP_DOMAIN = "test-shop.myshopify.com";
  process.env.SHOPIFY_API_VERSION = "2026-07";
  process.env.SHOPIFY_CLIENT_ID = "test-client-id";
  process.env.SHOPIFY_CLIENT_SECRET = "test-client-secret";
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function tokenResponse() {
  return jsonResponse({ access_token: "tok_123", expires_in: 3600 });
}

function customerOrdersResponse(orderGids: string[]) {
  return jsonResponse({
    data: {
      customer: {
        numberOfOrders: String(orderGids.length),
        amountSpent: null,
        orders: {
          edges: orderGids.map((gid, i) => ({
            node: {
              id: gid,
              legacyResourceId: String(1000 + i),
              name: `#${1000 + i}`,
              createdAt: "2026-09-01T00:00:00Z",
              displayFinancialStatus: "PAID",
              displayFulfillmentStatus: "FULFILLED",
              currentTotalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "EUR" } },
              lineItems: { edges: [] },
            },
          })),
        },
      },
    },
  });
}

function customerDraftOrdersResponse(draftGids: string[]) {
  return jsonResponse({
    data: {
      draftOrders: {
        edges: draftGids.map((gid, i) => ({
          node: {
            id: gid,
            legacyResourceId: String(2000 + i),
            name: `#D${2000 + i}`,
            status: "OPEN",
            createdAt: "2026-09-01T00:00:00Z",
            updatedAt: "2026-09-01T00:00:00Z",
            totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "EUR" } },
            invoiceUrl: null,
            order: null,
          },
        })),
      },
    },
  });
}

describe("opportunity.service — Shopify external link customer integrity", () => {
  let owner: { id: string; role: "AGENT" };
  let customerAId: string;
  let customerBId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    const ownerUser = await createTestUser({ role: "AGENT" });
    owner = { id: ownerUser.id, role: "AGENT" };
    userIds.push(ownerUser.id);

    // Numeric-suffixed GIDs — required for getShopifyCustomerDraftOrders'
    // legacy-ID extraction (a UUID-suffixed GID, the fixtures.ts default,
    // is treated as malformed and short-circuits without calling Shopify
    // at all, per src/integrations/shopify/draft-orders.ts).
    const customerA = await prisma.customerProfile.create({
      data: { shopifyCustomerGid: "gid://shopify/Customer/9001", displayName: "Klant A (link-integrity-test)" },
    });
    const customerB = await prisma.customerProfile.create({
      data: { shopifyCustomerGid: "gid://shopify/Customer/9002", displayName: "Klant B (link-integrity-test)" },
    });
    customerAId = customerA.id;
    customerBId = customerB.id;
  });

  afterAll(async () => {
    await prisma.opportunityExternalLink.deleteMany({ where: { opportunity: { customerProfileId: { in: [customerAId, customerBId] } } } });
    await prisma.activity.deleteMany({ where: { customerProfileId: { in: [customerAId, customerBId] } } });
    await prisma.opportunity.deleteMany({ where: { customerProfileId: { in: [customerAId, customerBId] } } });
    await prisma.customerProfile.deleteMany({ where: { id: { in: [customerAId, customerBId] } } });
    for (const id of userIds) await cleanupUser(id);
    await prisma.$disconnect();
  });

  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("SHOPIFY_ORDER: customer A opportunity + customer A's own order -> success", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(customerOrdersResponse(["gid://shopify/Order/500"]));
    vi.stubGlobal("fetch", fetchMock);

    const { createOpportunity, addExternalLink } = await import("@/modules/opportunities/opportunity.service");
    const opportunity = await createOpportunity({ customerProfileId: customerAId, title: "Order same-customer", ownerUserId: owner.id }, owner);
    const link = await addExternalLink(opportunity.id, { linkType: "SHOPIFY_ORDER", externalRef: "gid://shopify/Order/500" }, owner);

    expect(link.externalRef).toBe("gid://shopify/Order/500");
    expect(link.linkType).toBe("SHOPIFY_ORDER");
  });

  it("SHOPIFY_ORDER: customer A opportunity + customer B's order -> rejected", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    // Customer A's own orders list does NOT contain the order being linked.
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(customerOrdersResponse(["gid://shopify/Order/501"]));
    vi.stubGlobal("fetch", fetchMock);

    const { createOpportunity, addExternalLink, OpportunityValidationError } = await import("@/modules/opportunities/opportunity.service");
    const opportunity = await createOpportunity({ customerProfileId: customerAId, title: "Order cross-customer", ownerUserId: owner.id }, owner);

    await expect(
      addExternalLink(opportunity.id, { linkType: "SHOPIFY_ORDER", externalRef: "gid://shopify/Order/CUSTOMER_B_ORDER" }, owner),
    ).rejects.toBeInstanceOf(OpportunityValidationError);

    const linkCount = await prisma.opportunityExternalLink.count({ where: { opportunityId: opportunity.id } });
    expect(linkCount).toBe(0);
  });

  it("SHOPIFY_ORDER: nonexistent order -> rejected", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(customerOrdersResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const { createOpportunity, addExternalLink, OpportunityValidationError } = await import("@/modules/opportunities/opportunity.service");
    const opportunity = await createOpportunity({ customerProfileId: customerAId, title: "Order nonexistent", ownerUserId: owner.id }, owner);

    await expect(
      addExternalLink(opportunity.id, { linkType: "SHOPIFY_ORDER", externalRef: "gid://shopify/Order/DOES_NOT_EXIST" }, owner),
    ).rejects.toBeInstanceOf(OpportunityValidationError);
  });

  it("SHOPIFY_DRAFT_ORDER: customer A opportunity + customer A's own draft order -> success", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(customerDraftOrdersResponse(["gid://shopify/DraftOrder/700"]));
    vi.stubGlobal("fetch", fetchMock);

    const { createOpportunity, addExternalLink } = await import("@/modules/opportunities/opportunity.service");
    const opportunity = await createOpportunity({ customerProfileId: customerAId, title: "Draft same-customer", ownerUserId: owner.id }, owner);
    const link = await addExternalLink(opportunity.id, { linkType: "SHOPIFY_DRAFT_ORDER", externalRef: "gid://shopify/DraftOrder/700" }, owner);

    expect(link.externalRef).toBe("gid://shopify/DraftOrder/700");
    expect(link.linkType).toBe("SHOPIFY_DRAFT_ORDER");
  });

  it("SHOPIFY_DRAFT_ORDER: customer A opportunity + customer B's draft order -> rejected", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(customerDraftOrdersResponse(["gid://shopify/DraftOrder/701"]));
    vi.stubGlobal("fetch", fetchMock);

    const { createOpportunity, addExternalLink, OpportunityValidationError } = await import("@/modules/opportunities/opportunity.service");
    const opportunity = await createOpportunity({ customerProfileId: customerAId, title: "Draft cross-customer", ownerUserId: owner.id }, owner);

    await expect(
      addExternalLink(opportunity.id, { linkType: "SHOPIFY_DRAFT_ORDER", externalRef: "gid://shopify/DraftOrder/CUSTOMER_B_DRAFT" }, owner),
    ).rejects.toBeInstanceOf(OpportunityValidationError);

    const linkCount = await prisma.opportunityExternalLink.count({ where: { opportunityId: opportunity.id } });
    expect(linkCount).toBe(0);
  });

  it("empty externalRef is rejected before any Shopify call is made", async () => {
    setShopifyEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { createOpportunity, addExternalLink, OpportunityValidationError } = await import("@/modules/opportunities/opportunity.service");
    const opportunity = await createOpportunity({ customerProfileId: customerAId, title: "Empty ref", ownerUserId: owner.id }, owner);

    await expect(addExternalLink(opportunity.id, { linkType: "SHOPIFY_ORDER", externalRef: "   " }, owner)).rejects.toBeInstanceOf(
      OpportunityValidationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("quote link types (OFFERTEAPP_QUOTE/S4U_QUOTE_APP_QUOTE) are NOT verified against a sibling API — documented Phase 4A limitation", async () => {
    // No Shopify env, no fetch stub at all — proves this path never touches
    // Shopify or any sibling API, exactly as documented in ADR-009 §9.
    const { createOpportunity, addExternalLink } = await import("@/modules/opportunities/opportunity.service");
    const opportunity = await createOpportunity({ customerProfileId: customerAId, title: "Quote link unverified", ownerUserId: owner.id }, owner);
    const link = await addExternalLink(opportunity.id, { linkType: "OFFERTEAPP_QUOTE", externalRef: "Q-ANY-REF" }, owner);
    expect(link.linkType).toBe("OFFERTEAPP_QUOTE");
  });
});
