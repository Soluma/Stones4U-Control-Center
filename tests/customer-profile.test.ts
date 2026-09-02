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

describe("getOrCreateCustomerProfile", () => {
  beforeEach(async () => {
    await prisma.customerProfile.deleteMany({ where: { shopifyCustomerGid: FAKE_GID } });
  });

  afterAll(async () => {
    await prisma.customerProfile.deleteMany({ where: { shopifyCustomerGid: FAKE_GID } });
    await prisma.$disconnect();
  });

  it("creates exactly one CustomerProfile for a new Shopify GID", async () => {
    const { getOrCreateCustomerProfile } = await import("@/modules/crm/customer-profile.service");
    const profile = await getOrCreateCustomerProfile(FAKE_GID);
    expect(profile?.shopifyCustomerGid).toBe(FAKE_GID);
    expect(profile?.phoneNormalized).toBe("31612345678");

    const count = await prisma.customerProfile.count({ where: { shopifyCustomerGid: FAKE_GID } });
    expect(count).toBe(1);
  });

  it("never creates a duplicate profile for the same GID (dedup guarantee, ADR-002)", async () => {
    const { getOrCreateCustomerProfile } = await import("@/modules/crm/customer-profile.service");

    await Promise.all([
      getOrCreateCustomerProfile(FAKE_GID),
      getOrCreateCustomerProfile(FAKE_GID),
      getOrCreateCustomerProfile(FAKE_GID),
    ]);

    const count = await prisma.customerProfile.count({ where: { shopifyCustomerGid: FAKE_GID } });
    expect(count).toBe(1);
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
