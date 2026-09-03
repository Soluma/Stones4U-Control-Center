import "server-only";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { normalizeDutchPhone } from "@/lib/phone";
import { getShopifyCustomerByGid, searchShopifyCustomers } from "@/integrations/shopify/customers";
import { getShopifyCustomerOrders } from "@/integrations/shopify/orders";
import type { ShopifyCustomerSummary, CustomerOrdersResult } from "@/integrations/shopify/types";
import type { CrmStatus, CustomerType } from "@/generated/prisma";

export type CustomerSearchResult = {
  shopify: ShopifyCustomerSummary;
  customerProfileId: string | null;
};

/** Read-only search — does NOT create a CustomerProfile. A profile is only
 * ever created (lazily, deduped on shopifyCustomerGid) the first time a
 * customer is actually opened — see getOrCreateCustomerProfile().
 *
 * Phone-shaped terms are normalized before hitting Shopify: Shopify's
 * customer search matches phone numbers only without a leading "0"
 * (confirmed empirically during Phase 3b local integration testing — the
 * raw Dutch "06..." form returns zero results, "6..."/"316..."/"+316..."
 * all match) — normalizeDutchPhone() already produces exactly that form,
 * so this reuses it rather than adding a second phone-format assumption. */
export async function searchCustomers(term: string): Promise<CustomerSearchResult[]> {
  const normalizedPhone = normalizeDutchPhone(term);
  const searchTerm = normalizedPhone ?? term;
  const shopifyResults = await searchShopifyCustomers(searchTerm, 15);
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
 *
 * Phase 5a (docs/architecture/ADR-011-CUSTOMER-IDENTITY-TYPE.md §2):
 * displayName/email/phone always refresh unconditionally from Shopify.
 * companyName only refreshes — including being cleared back to null —
 * when the existing profile's companyNameConfirmed is false; once a human
 * has confirmed/corrected companyName (updateCustomerCrmFields()), this
 * sync leaves it alone. CRM-owned fields (crmStatus, accountManagerId,
 * tags, customerTypeOverride, companyNameConfirmed itself) are never
 * touched here.
 *
 * `options.shopify` lets a caller that already fetched this customer for
 * its own purposes (getCustomer360()) reuse that read instead of costing a
 * second Shopify API call for the same customer.
 */
export async function syncCustomerIdentityFromShopify(shopifyGid: string, options: { shopify?: ShopifyCustomerSummary } = {}) {
  const shopify = options.shopify ?? (await getShopifyCustomerByGid(shopifyGid));
  if (!shopify) return null;

  const existing = await prisma.customerProfile.findUnique({
    where: { shopifyCustomerGid: shopifyGid },
    select: { companyNameConfirmed: true },
  });
  const companyNameUpdate = existing?.companyNameConfirmed ? {} : { companyName: shopify.company };

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
      email: shopify.email,
      phone: shopify.phone,
      phoneNormalized: normalizeDutchPhone(shopify.phone),
      lastSyncedAt: new Date(),
      ...companyNameUpdate,
    },
  });
}

export type Customer360 = {
  profile: NonNullable<Awaited<ReturnType<typeof syncCustomerIdentityFromShopify>>>;
  shopify: ShopifyCustomerSummary;
  orders: CustomerOrdersResult;
};

/** Aggregates the local CustomerProfile with a live Shopify read (customer +
 * orders). Shopify failures propagate (the identity source is unavailable,
 * which the UI must surface clearly); local-data failures do not, so a
 * transient Shopify hiccup never wipes out a page that still has local
 * notes/tasks to show — callers render around this by catching independently
 * per data source (see src/app/customers/[id]/page.tsx).
 *
 * Also refreshes the local identity snapshot (Phase 5a) from the same
 * Shopify read already fetched for display — no extra Shopify API call. */
export async function getCustomer360(customerProfileId: string): Promise<Customer360 | null> {
  const existingProfile = await prisma.customerProfile.findUnique({ where: { id: customerProfileId } });
  if (!existingProfile) return null;

  const [shopify, orders] = await Promise.all([
    getShopifyCustomerByGid(existingProfile.shopifyCustomerGid),
    getShopifyCustomerOrders(existingProfile.shopifyCustomerGid),
  ]);

  if (!shopify) return null;

  const profile = (await syncCustomerIdentityFromShopify(existingProfile.shopifyCustomerGid, { shopify })) ?? existingProfile;

  return { profile, shopify, orders };
}

export type CustomerCrmFieldChanges = {
  crmStatus?: CrmStatus;
  accountManagerId?: string | null;
  /** 100% Control-Center-owned (ADR-011 §3) — Shopify has no "type"
   * concept, so this is never touched by syncCustomerIdentityFromShopify().
   * null means "derive from companyName", not "INDIVIDUAL". */
  customerTypeOverride?: CustomerType | null;
  /** A manual company-name correction. An explicit empty/null value is a
   * deliberate "no company" confirmation, not "field not provided" — both
   * cases set companyNameConfirmed=true so the next Shopify sync leaves it
   * alone (ADR-011 §2, build spec §8). */
  companyName?: string | null;
};

export async function updateCustomerCrmFields(customerProfileId: string, rawChanges: CustomerCrmFieldChanges, actor: { id: string }) {
  const before = await prisma.customerProfile.findUniqueOrThrow({ where: { id: customerProfileId } });

  // Strip not-provided (undefined) keys before diff/audit so a caller that
  // builds `changes` from a wider object (e.g. a parsed request body with
  // several optional fields) never has untouched fields show up as "changed
  // to undefined" in the activity/audit trail.
  const changes = Object.fromEntries(Object.entries(rawChanges).filter(([, v]) => v !== undefined)) as CustomerCrmFieldChanges;

  const data: CustomerCrmFieldChanges & { companyNameConfirmed?: boolean } = { ...changes };
  if (changes.companyName !== undefined) {
    data.companyName = changes.companyName?.trim() || null;
    data.companyNameConfirmed = true;
  }

  const updated = await prisma.customerProfile.update({
    where: { id: customerProfileId },
    data,
  });

  await prisma.activity.create({
    data: {
      customerProfileId,
      type: "CUSTOMER_PROFILE_UPDATED",
      sourceType: "CONTROL_CENTER",
      title: "CRM-gegevens bijgewerkt",
      occurredAt: new Date(),
      actorId: actor.id,
      metadata: { before: diffFields(before, data), after: data } as never,
    },
  });

  await logAudit({
    userId: actor.id,
    action: "customer_profile.updated",
    entityType: "CustomerProfile",
    entityId: customerProfileId,
    metadata: { changes: data },
  });

  return updated;
}

/** Atomically resets companyName back to Shopify's current value (build
 * spec §9): one live Shopify read, then companyName is set to exactly what
 * Shopify has right now — including null — and companyNameConfirmed is
 * cleared to false so future syncs resume following Shopify again. This is
 * the one explicit, human-triggered action allowed to make a live Shopify
 * read outside of getCustomer360()/search. */
export async function resetCompanyNameToShopify(customerProfileId: string, actor: { id: string }) {
  const before = await prisma.customerProfile.findUniqueOrThrow({ where: { id: customerProfileId } });
  const shopify = await getShopifyCustomerByGid(before.shopifyCustomerGid);
  if (!shopify) {
    throw new Error("Shopify-klant niet gevonden.");
  }

  const data = { companyName: shopify.company, companyNameConfirmed: false };

  const updated = await prisma.customerProfile.update({
    where: { id: customerProfileId },
    data,
  });

  await prisma.activity.create({
    data: {
      customerProfileId,
      type: "CUSTOMER_PROFILE_UPDATED",
      sourceType: "CONTROL_CENTER",
      title: "Bedrijfsnaam teruggezet naar Shopify",
      occurredAt: new Date(),
      actorId: actor.id,
      metadata: { before: diffFields(before, data), after: data } as never,
    },
  });

  await logAudit({
    userId: actor.id,
    action: "customer_profile.updated",
    entityType: "CustomerProfile",
    entityId: customerProfileId,
    metadata: { changes: data, reset: true },
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
