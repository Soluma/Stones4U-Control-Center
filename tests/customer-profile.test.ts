import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db/prisma";

const FAKE_GID = "gid://shopify/Customer/999000111";

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
  searchShopifyCustomers: vi.fn(async () => []),
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
