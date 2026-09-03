import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db/prisma";

const FAKE_GID = "gid://shopify/Customer/999000111";

const mockSearchShopifyCustomers = vi.fn(async () => [] as unknown[]);
vi.mock("@/integrations/shopify/customers", () => ({
  getShopifyCustomerByGid: vi.fn(async (gid: string) => ({
    gid,
    legacyId: "999000111",
    displayName: "Test Klant",
    firstName: "Test",
    lastName: "Klant",
    email: "test@example.com",
    phone: "+31612345678",
    company: "Test BV",
    defaultAddressSummary: "Teststraat 1, Amsterdam",
    numberOfOrders: 2,
    amountSpent: { amount: "150.00", currencyCode: "EUR" },
  })),
  searchShopifyCustomers: (...args: Parameters<typeof mockSearchShopifyCustomers>) => mockSearchShopifyCustomers(...args),
}));

describe("syncCustomerIdentityFromShopify", () => {
  beforeEach(async () => {
    await prisma.customerProfile.deleteMany({ where: { shopifyCustomerGid: FAKE_GID } });
  });

  afterAll(async () => {
    await prisma.customerProfile.deleteMany({ where: { shopifyCustomerGid: FAKE_GID } });
    await prisma.$disconnect();
  });

  it("creates exactly one CustomerProfile for a new Shopify GID", async () => {
    const { syncCustomerIdentityFromShopify } = await import("@/modules/crm/customer-profile.service");
    const profile = await syncCustomerIdentityFromShopify(FAKE_GID);
    expect(profile?.shopifyCustomerGid).toBe(FAKE_GID);
    expect(profile?.phoneNormalized).toBe("31612345678");

    const count = await prisma.customerProfile.count({ where: { shopifyCustomerGid: FAKE_GID } });
    expect(count).toBe(1);
  });

  it("never creates a duplicate profile for the same GID (dedup guarantee, ADR-002)", async () => {
    const { syncCustomerIdentityFromShopify } = await import("@/modules/crm/customer-profile.service");

    await Promise.all([
      syncCustomerIdentityFromShopify(FAKE_GID),
      syncCustomerIdentityFromShopify(FAKE_GID),
      syncCustomerIdentityFromShopify(FAKE_GID),
    ]);

    const count = await prisma.customerProfile.count({ where: { shopifyCustomerGid: FAKE_GID } });
    expect(count).toBe(1);
  });
});

describe("syncCustomerIdentityFromShopify — companyNameConfirmed guard (ADR-011 §2, build spec §6)", () => {
  const GID = `gid://shopify/Customer/${crypto.randomUUID()}`;

  afterAll(async () => {
    await prisma.customerProfile.deleteMany({ where: { shopifyCustomerGid: GID } });
  });

  it("refreshes companyName unconditionally while companyNameConfirmed is false, including clearing it to null when Shopify's company becomes null", async () => {
    const { getShopifyCustomerByGid } = await import("@/integrations/shopify/customers");
    const { syncCustomerIdentityFromShopify } = await import("@/modules/crm/customer-profile.service");

    vi.mocked(getShopifyCustomerByGid).mockResolvedValueOnce({
      gid: GID,
      legacyId: "1",
      displayName: "Jan Jansen",
      firstName: "Jan",
      lastName: "Jansen",
      email: "jan@example.com",
      phone: null,
      company: "Jansen Tuinen BV",
      defaultAddressSummary: null,
      numberOfOrders: 0,
      amountSpent: null,
    });
    const created = await syncCustomerIdentityFromShopify(GID);
    expect(created?.companyName).toBe("Jansen Tuinen BV");
    expect(created?.companyNameConfirmed).toBe(false);

    vi.mocked(getShopifyCustomerByGid).mockResolvedValueOnce({
      gid: GID,
      legacyId: "1",
      displayName: "Jan Jansen",
      firstName: "Jan",
      lastName: "Jansen",
      email: "jan@example.com",
      phone: null,
      company: null,
      defaultAddressSummary: null,
      numberOfOrders: 0,
      amountSpent: null,
    });
    const resynced = await syncCustomerIdentityFromShopify(GID);
    expect(resynced?.companyName).toBeNull();
  });

  it("never touches companyName once companyNameConfirmed is true, even when Shopify's value changes", async () => {
    const { getShopifyCustomerByGid } = await import("@/integrations/shopify/customers");
    const { syncCustomerIdentityFromShopify, updateCustomerCrmFields } = await import("@/modules/crm/customer-profile.service");

    vi.mocked(getShopifyCustomerByGid).mockResolvedValueOnce({
      gid: GID,
      legacyId: "1",
      displayName: "Jan Jansen",
      firstName: "Jan",
      lastName: "Jansen",
      email: "jan@example.com",
      phone: null,
      company: "Oude Naam BV",
      defaultAddressSummary: null,
      numberOfOrders: 0,
      amountSpent: null,
    });
    const profile = await syncCustomerIdentityFromShopify(GID);
    expect(profile).not.toBeNull();

    const testUser = await prisma.user.create({
      data: {
        email: `${crypto.randomUUID()}@example.com`,
        passwordHash: "x",
        name: "Test Actor",
        role: "ADMIN",
      },
    });

    await updateCustomerCrmFields(profile!.id, { companyName: "Correcte Naam BV" }, { id: testUser.id });

    vi.mocked(getShopifyCustomerByGid).mockResolvedValueOnce({
      gid: GID,
      legacyId: "1",
      displayName: "Jan Jansen — bijgewerkt",
      firstName: "Jan",
      lastName: "Jansen",
      email: "jan@example.com",
      phone: null,
      company: "Shopify Naam BV",
      defaultAddressSummary: null,
      numberOfOrders: 0,
      amountSpent: null,
    });
    const resynced = await syncCustomerIdentityFromShopify(GID);
    expect(resynced?.companyName).toBe("Correcte Naam BV");
    expect(resynced?.displayName).toBe("Jan Jansen — bijgewerkt");

    await prisma.user.delete({ where: { id: testUser.id } });
  });
});

describe("resetCompanyNameToShopify — atomic reset (build spec §9)", () => {
  const GID = `gid://shopify/Customer/${crypto.randomUUID()}`;

  afterAll(async () => {
    await prisma.customerProfile.deleteMany({ where: { shopifyCustomerGid: GID } });
  });

  it("sets companyName to the live Shopify value and clears companyNameConfirmed, in one atomic action", async () => {
    const { getShopifyCustomerByGid } = await import("@/integrations/shopify/customers");
    const { syncCustomerIdentityFromShopify, updateCustomerCrmFields, resetCompanyNameToShopify } = await import(
      "@/modules/crm/customer-profile.service"
    );

    vi.mocked(getShopifyCustomerByGid).mockResolvedValueOnce({
      gid: GID,
      legacyId: "1",
      displayName: "Jan Jansen",
      firstName: "Jan",
      lastName: "Jansen",
      email: "jan@example.com",
      phone: null,
      company: "Shopify BV",
      defaultAddressSummary: null,
      numberOfOrders: 0,
      amountSpent: null,
    });
    const profile = await syncCustomerIdentityFromShopify(GID);

    const testUser = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Test Actor", role: "ADMIN" },
    });

    await updateCustomerCrmFields(profile!.id, { companyName: "Handmatige Naam" }, { id: testUser.id });

    vi.mocked(getShopifyCustomerByGid).mockResolvedValueOnce({
      gid: GID,
      legacyId: "1",
      displayName: "Jan Jansen",
      firstName: "Jan",
      lastName: "Jansen",
      email: "jan@example.com",
      phone: null,
      company: "Shopify BV",
      defaultAddressSummary: null,
      numberOfOrders: 0,
      amountSpent: null,
    });
    const reset = await resetCompanyNameToShopify(profile!.id, { id: testUser.id });
    expect(reset.companyName).toBe("Shopify BV");
    expect(reset.companyNameConfirmed).toBe(false);

    await prisma.user.delete({ where: { id: testUser.id } });
  });
});

describe("updateCustomerCrmFields — customerTypeOverride and companyName are independent (build spec §10)", () => {
  const GID = `gid://shopify/Customer/${crypto.randomUUID()}`;

  afterAll(async () => {
    await prisma.customerProfile.deleteMany({ where: { shopifyCustomerGid: GID } });
  });

  it("a type override wins regardless of companyName presence, in both directions", async () => {
    const { getShopifyCustomerByGid } = await import("@/integrations/shopify/customers");
    const { syncCustomerIdentityFromShopify, updateCustomerCrmFields } = await import("@/modules/crm/customer-profile.service");
    const { effectiveCustomerType } = await import("@/modules/crm/customer-identity");

    vi.mocked(getShopifyCustomerByGid).mockResolvedValueOnce({
      gid: GID,
      legacyId: "1",
      displayName: "Jan Jansen",
      firstName: "Jan",
      lastName: "Jansen",
      email: "jan@example.com",
      phone: null,
      company: null,
      defaultAddressSummary: null,
      numberOfOrders: 0,
      amountSpent: null,
    });
    const profile = await syncCustomerIdentityFromShopify(GID);
    expect(effectiveCustomerType(profile!)).toBe("INDIVIDUAL");

    const testUser = await prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Test Actor", role: "ADMIN" },
    });

    const asOrg = await updateCustomerCrmFields(profile!.id, { customerTypeOverride: "ORGANIZATION" }, { id: testUser.id });
    expect(effectiveCustomerType(asOrg)).toBe("ORGANIZATION");

    const asIndividualAgain = await updateCustomerCrmFields(
      profile!.id,
      { customerTypeOverride: "INDIVIDUAL", companyName: "Toch Een Bedrijf BV" },
      { id: testUser.id },
    );
    expect(effectiveCustomerType(asIndividualAgain)).toBe("INDIVIDUAL");
    expect(asIndividualAgain.companyName).toBe("Toch Een Bedrijf BV");

    await prisma.user.delete({ where: { id: testUser.id } });
  });
});

describe("searchCustomers — phone-shaped term normalization", () => {
  beforeEach(() => {
    mockSearchShopifyCustomers.mockClear();
  });

  it("normalizes a raw Dutch '06...' term before querying Shopify — that raw form matches nothing on Shopify's side (confirmed empirically), but the normalized '316...' form does", async () => {
    const { searchCustomers } = await import("@/modules/crm/customer-profile.service");
    await searchCustomers("0649899477");
    expect(mockSearchShopifyCustomers).toHaveBeenCalledWith("31649899477", 15);
  });

  it("normalizes a '+31...' or bare '31...' term identically, so all phone-shaped inputs converge on one Shopify query form", async () => {
    const { searchCustomers } = await import("@/modules/crm/customer-profile.service");
    await searchCustomers("+31649899477");
    expect(mockSearchShopifyCustomers).toHaveBeenCalledWith("31649899477", 15);

    mockSearchShopifyCustomers.mockClear();
    await searchCustomers("31649899477");
    expect(mockSearchShopifyCustomers).toHaveBeenCalledWith("31649899477", 15);
  });

  it("leaves a non-phone-shaped term (a name) untouched", async () => {
    const { searchCustomers } = await import("@/modules/crm/customer-profile.service");
    await searchCustomers("Fons Verkoelen");
    expect(mockSearchShopifyCustomers).toHaveBeenCalledWith("Fons Verkoelen", 15);
  });
});
