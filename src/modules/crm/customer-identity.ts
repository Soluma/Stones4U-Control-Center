import type { CustomerType } from "@/generated/prisma";
import type { ShopifyCustomerSummary } from "@/integrations/shopify/types";

// Shared persoon/organisatie identity helpers — docs/architecture/ADR-011-
// CUSTOMER-IDENTITY-TYPE.md. Deliberately NOT "server-only" (no prisma
// runtime import, only types) so both server and client components can
// import this one source of truth — same convention as
// src/modules/opportunities/labels.ts's effectiveProbability().

export type CustomerIdentityInput = {
  companyName: string | null;
  customerTypeOverride: CustomerType | null;
};

/** The value used for display/classification: an explicit human override if
 * set, otherwise derived from whether Shopify's own company field is
 * filled. Never persisted as its own column — exact same pattern as
 * effectiveProbability() (ADR-009). An empty/whitespace-only companyName is
 * treated as "not filled" (ADR-011 §1). */
export function effectiveCustomerType(profile: CustomerIdentityInput): CustomerType {
  if (profile.customerTypeOverride) return profile.customerTypeOverride;
  return profile.companyName && profile.companyName.trim() !== "" ? "ORGANIZATION" : "INDIVIDUAL";
}

export type CustomerDisplayInput = CustomerIdentityInput & {
  displayName: string | null;
};

/** The primary klantnaam shown everywhere (customer list, opportunities,
 * tasks, search, command palette): the company name for an organization,
 * the account-holder name for an individual. Falls back safely to
 * displayName when customerTypeOverride=ORGANIZATION but companyName is
 * null/empty — never renders an empty/broken name (build spec §3). */
export function customerDisplayName(profile: CustomerDisplayInput): string {
  const type = effectiveCustomerType(profile);
  const company = profile.companyName?.trim() || null;
  if (type === "ORGANIZATION" && company) return company;
  return profile.displayName?.trim() || company || "Klant";
}

/** The subordinate "Accounthouder: {naam}" line for an organization —
 * null when there's nothing subordinate to show: not an organization, no
 * account-holder name, or the account-holder name is identical to the
 * primary display name already shown (never a duplicate line, build spec
 * §3). */
export function customerSecondaryName(profile: CustomerDisplayInput): string | null {
  const type = effectiveCustomerType(profile);
  if (type !== "ORGANIZATION") return null;
  const holder = profile.displayName?.trim() || null;
  if (!holder) return null;
  const primary = customerDisplayName(profile);
  if (holder === primary) return null;
  return holder;
}

/** Same presentation rule as customerDisplayName(), for a live Shopify
 * search result that has no local CustomerProfile yet — no
 * customerTypeOverride is available at that point, so classification
 * relies solely on Shopify's own company field (build spec §17). */
export function shopifyCustomerDisplayName(customer: Pick<ShopifyCustomerSummary, "displayName" | "company">): string {
  const company = customer.company?.trim() || null;
  if (company) return company;
  return customer.displayName?.trim() || "Klant";
}

/** Shopify-summary counterpart to customerSecondaryName() — same "no
 * duplicate line" rule. */
export function shopifyCustomerSecondaryName(customer: Pick<ShopifyCustomerSummary, "displayName" | "company">): string | null {
  const company = customer.company?.trim() || null;
  if (!company) return null;
  const holder = customer.displayName?.trim() || null;
  if (!holder || holder === company) return null;
  return holder;
}
