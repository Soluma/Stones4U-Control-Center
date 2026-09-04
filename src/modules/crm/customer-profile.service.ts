import "server-only";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { normalizeDutchPhone } from "@/lib/phone";
import { getShopifyCustomerByGid, searchShopifyCustomers } from "@/integrations/shopify/customers";
import { getShopifyCustomerOrders } from "@/integrations/shopify/orders";
import type { ShopifyCustomerSummary, CustomerOrdersResult } from "@/integrations/shopify/types";
import type { CrmStatus, CustomerType } from "@/generated/prisma";
import { Prisma } from "@/generated/prisma";

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

// ---------------------------------------------------------------------------
// Phase 6b — local customer list (docs/platform-discovery/48-PHASE-6B-BUILD-SPEC.md)
// ---------------------------------------------------------------------------

export type CustomerListScope = "mine" | "unassigned" | "all";

export type CustomerListItem = {
  id: string;
  displayName: string | null;
  companyName: string | null;
  customerTypeOverride: CustomerType | null;
  crmStatus: CrmStatus;
  updatedAt: Date;
  accountManager: { id: string; name: string; active: boolean } | null;
};

const customerListSelect = {
  id: true,
  displayName: true,
  companyName: true,
  customerTypeOverride: true,
  crmStatus: true,
  updatedAt: true,
  accountManager: { select: { id: true, name: true, active: true } },
} as const;

/** "mine"/"unassigned" always resolve against the actor's own id — this is
 * never a client-supplied filter (build spec §5/§9); callers must always
 * pass the server-side session actor. */
function customerScopeWhere(scope: CustomerListScope, actorId: string): Prisma.CustomerProfileWhereInput {
  if (scope === "mine") return { accountManagerId: actorId };
  if (scope === "unassigned") return { accountManagerId: null };
  return {};
}

/** The local customer list (Phase 6B) — deliberately scoped to
 * locally-materialized CustomerProfile rows only, never a live Shopify
 * customer listing (architecture doc §3, "Optie A"). The existing
 * searchCustomers()/CustomerSearch live-Shopify search stays the only path
 * to a not-yet-locally-known customer — this function never creates a
 * profile, never calls Shopify. Search term is combined with the scope
 * filter in the same query (never a separate, unscoped search step) so a
 * search inside "mine" can never surface another accountmanager's
 * customer. Pagination (skip/take) is applied at the database level, after
 * the where-clause — never a fetch-all-then-slice. */
export async function listCustomerProfiles(
  actor: { id: string },
  opts: { scope: CustomerListScope; search?: string; page?: number; pageSize?: number },
): Promise<{ customers: CustomerListItem[]; total: number }> {
  const page = opts.page && opts.page > 0 ? Math.floor(opts.page) : 1;
  const pageSize = opts.pageSize && opts.pageSize > 0 ? Math.floor(opts.pageSize) : 25;
  const term = opts.search?.trim();

  const where: Prisma.CustomerProfileWhereInput = {
    ...customerScopeWhere(opts.scope, actor.id),
    ...(term
      ? { OR: [{ displayName: { contains: term, mode: "insensitive" } }, { companyName: { contains: term, mode: "insensitive" } }] }
      : {}),
  };

  const [customers, total] = await Promise.all([
    prisma.customerProfile.findMany({
      where,
      select: customerListSelect,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.customerProfile.count({ where }),
  ]);

  return { customers, total };
}

/** Tab counts for the customer list — three small, independent counts
 * (never a per-row/per-customer query), always actor-scoped for "mine". */
export async function getCustomerListCounts(actor: { id: string }): Promise<Record<CustomerListScope, number>> {
  const [mine, unassigned, all] = await Promise.all([
    prisma.customerProfile.count({ where: customerScopeWhere("mine", actor.id) }),
    prisma.customerProfile.count({ where: customerScopeWhere("unassigned", actor.id) }),
    prisma.customerProfile.count({ where: customerScopeWhere("all", actor.id) }),
  ]);
  return { mine, unassigned, all };
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

/** "Aan mij toewijzen" (build spec §1.5) — concurrency-safe, not a blind
 * last-write-wins. The UI only ever shows this action from an
 * accountManagerId=null state; the conditional `updateMany` below re-checks
 * that same condition at write time, atomically, so a second employee who
 * clicks the same button a moment after a first employee already claimed
 * the customer can never silently overwrite that assignment (final review
 * §10 — never explicitly decided in the build spec, so the safer,
 * conditional behavior is the one implemented). Returns null when the
 * customer was no longer unassigned — callers must surface this as a
 * conflict, not treat it as success. Never touches Opportunity.ownerUserId/
 * Task.assignedToId (no coupling, unchanged from updateCustomerCrmFields()'s
 * own guarantee) and reuses the exact same Activity/audit shape. */
export async function assignCustomerToSelfIfUnassigned(customerProfileId: string, actor: { id: string }) {
  const before = await prisma.customerProfile.findUniqueOrThrow({ where: { id: customerProfileId } });

  const result = await prisma.customerProfile.updateMany({
    where: { id: customerProfileId, accountManagerId: null },
    data: { accountManagerId: actor.id },
  });
  if (result.count === 0) return null;

  const updated = await prisma.customerProfile.findUniqueOrThrow({ where: { id: customerProfileId } });

  await prisma.activity.create({
    data: {
      customerProfileId,
      type: "CUSTOMER_PROFILE_UPDATED",
      sourceType: "CONTROL_CENTER",
      title: "CRM-gegevens bijgewerkt",
      occurredAt: new Date(),
      actorId: actor.id,
      metadata: { before: { accountManagerId: before.accountManagerId }, after: { accountManagerId: actor.id } } as never,
    },
  });

  await logAudit({
    userId: actor.id,
    action: "customer_profile.updated",
    entityType: "CustomerProfile",
    entityId: customerProfileId,
    metadata: { changes: { accountManagerId: actor.id }, assignToSelf: true },
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
