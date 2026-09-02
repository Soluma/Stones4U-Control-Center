import "server-only";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { normalizeDutchPhone } from "@/lib/phone";
import { getShopifyCustomerByGid, searchShopifyCustomers } from "@/integrations/shopify/customers";
import { getShopifyCustomerOrders } from "@/integrations/shopify/orders";
import type { ShopifyCustomerSummary, CustomerOrdersResult } from "@/integrations/shopify/types";
import type { CrmStatus } from "@/generated/prisma";

export type CustomerSearchResult = {
  shopify: ShopifyCustomerSummary;
  customerProfileId: string | null;
};

/** Read-only search — does NOT create a CustomerProfile. A profile is only
 * ever created (lazily, deduped on shopifyCustomerGid) the first time a
 * customer is actually opened — see getOrCreateCustomerProfile(). */
export async function searchCustomers(term: string): Promise<CustomerSearchResult[]> {
  const shopifyResults = await searchShopifyCustomers(term, 15);
  if (shopifyResults.length === 0) return [];

  const existingProfiles = await prisma.customerProfile.findMany({
    where: { shopifyCustomerGid: { in: shopifyResults.map((c) => c.gid) } },
    select: { id: true, shopifyCustomerGid: true },
  });
  const profileByGid = new Map(existingProfiles.map((p) => [p.shopifyCustomerGid, p.id]));

  return shopifyResults.map((shopify) => ({
    shopify,
    customerProfileId: profileByGid.get(shopify.gid) ?? null,
  }));
}

/**
 * Lazily creates (or refreshes the snapshot of) a CustomerProfile for a
 * Shopify customer GID. Deduplication is guaranteed by the database's
 * unique constraint on shopifyCustomerGid (prisma/schema.prisma) — an upsert
 * can never produce two profiles for the same Shopify customer, unlike
 * TelefoonSysteem's Contact table (keyed on a raw phone string with no
 * upstream identity check — docs/platform-discovery/22 §3).
 */
export async function getOrCreateCustomerProfile(shopifyGid: string) {
  const shopify = await getShopifyCustomerByGid(shopifyGid);
  if (!shopify) return null;

  return prisma.customerProfile.upsert({
    where: { shopifyCustomerGid: shopifyGid },
    create: {
      shopifyCustomerGid: shopifyGid,
      displayName: shopify.displayName,
      companyName: shopify.company,
      email: shopify.email,
      phone: shopify.phone,
      phoneNormalized: normalizeDutchPhone(shopify.phone),
      lastSyncedAt: new Date(),
    },
    update: {
      displayName: shopify.displayName,
      companyName: shopify.company,
      email: shopify.email,
      phone: shopify.phone,
      phoneNormalized: normalizeDutchPhone(shopify.phone),
      lastSyncedAt: new Date(),
    },
  });
}

export type Customer360 = {
  profile: NonNullable<Awaited<ReturnType<typeof getOrCreateCustomerProfile>>>;
  shopify: ShopifyCustomerSummary;
  orders: CustomerOrdersResult;
};

/** Aggregates the local CustomerProfile with a live Shopify read (customer +
 * orders). Shopify failures propagate (the identity source is unavailable,
 * which the UI must surface clearly); local-data failures do not, so a
 * transient Shopify hiccup never wipes out a page that still has local
 * notes/tasks to show — callers render around this by catching independently
 * per data source (see src/app/customers/[id]/page.tsx). */
export async function getCustomer360(customerProfileId: string): Promise<Customer360 | null> {
  const profile = await prisma.customerProfile.findUnique({ where: { id: customerProfileId } });
  if (!profile) return null;

  const [shopify, orders] = await Promise.all([
    getShopifyCustomerByGid(profile.shopifyCustomerGid),
    getShopifyCustomerOrders(profile.shopifyCustomerGid),
  ]);

  if (!shopify) return null;

  return { profile, shopify, orders };
}

export async function updateCustomerCrmFields(
  customerProfileId: string,
  changes: { crmStatus?: CrmStatus; accountManagerId?: string | null },
  actor: { id: string },
) {
  const before = await prisma.customerProfile.findUniqueOrThrow({ where: { id: customerProfileId } });

  const updated = await prisma.customerProfile.update({
    where: { id: customerProfileId },
    data: changes,
  });

  await prisma.activity.create({
    data: {
      customerProfileId,
      type: "CUSTOMER_PROFILE_UPDATED",
      sourceType: "CONTROL_CENTER",
      title: "CRM-gegevens bijgewerkt",
      occurredAt: new Date(),
      actorId: actor.id,
      metadata: { before: diffFields(before, changes), after: changes } as never,
    },
  });

  await logAudit({
    userId: actor.id,
    action: "customer_profile.updated",
    entityType: "CustomerProfile",
    entityId: customerProfileId,
    metadata: { changes },
  });

  return updated;
}

function diffFields<T extends object>(before: T, changes: Partial<T>): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(changes) as (keyof T)[]) {
    result[key] = before[key];
  }
  return result;
}
