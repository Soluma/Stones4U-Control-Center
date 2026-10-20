import "server-only";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import type { SessionUser } from "@/platform/auth/session";
import { readCustomerCreditRaw } from "@/integrations/shopify/on-account-read";
import { writeCustomerCredit } from "@/integrations/shopify/on-account";
import { InvalidTermDaysError, MAX_TERM_DAYS, resolveCustomerCredit, type CustomerCredit } from "./rules";

// Op rekening v1 — the two customer metafields (stones4u.credit_allowed,
// stones4u.payment_term_days) are Shopify-owned (ADR-002: nothing copied into
// CustomerProfile); the CRM reads them live and, for an ADMIN, writes them.

export class CustomerCreditError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type CustomerCreditView = {
  customerGid: string;
  creditAllowed: boolean;
  /** The term that will be snapshot on a new order (30 when not set). */
  effectiveTermDays: number | null;
  /** The raw stored term; null = not set (default applies). */
  storedTermDays: number | null;
  /** A stored value the rules reject — shown, never silently replaced. */
  invalidStoredValue: string | null;
};

function toView(customerGid: string, creditAllowed: string | null, termDays: string | null): CustomerCreditView {
  let credit: CustomerCredit;
  try {
    credit = resolveCustomerCredit(creditAllowed, termDays);
  } catch (error) {
    if (!(error instanceof InvalidTermDaysError)) throw error;
    return { customerGid, creditAllowed: creditAllowed === "true", effectiveTermDays: null, storedTermDays: null, invalidStoredValue: error.raw };
  }
  const stored = termDays && /^\d+$/.test(termDays.trim()) ? Number(termDays.trim()) : null;
  return {
    customerGid,
    creditAllowed: credit.allowed,
    effectiveTermDays: credit.allowed ? credit.termDays : null,
    storedTermDays: stored,
    invalidStoredValue: null,
  };
}

async function profileCustomerGid(profileId: string): Promise<string> {
  const profile = await prisma.customerProfile.findUnique({ where: { id: profileId }, select: { shopifyCustomerGid: true } });
  if (!profile) throw new CustomerCreditError("Klant niet gevonden.", 404);
  return profile.shopifyCustomerGid;
}

export async function getCustomerCredit(profileId: string): Promise<CustomerCreditView> {
  const gid = await profileCustomerGid(profileId);
  const raw = await readCustomerCreditRaw(gid);
  if (!raw) throw new CustomerCreditError("Klant niet gevonden in Shopify.", 404);
  return toView(gid, raw.creditAllowed, raw.termDays);
}

export async function setCustomerCredit(
  profileId: string,
  input: { creditAllowed: boolean; termDays: number | null },
  actor: SessionUser,
): Promise<CustomerCreditView> {
  if (input.termDays !== null && (!Number.isInteger(input.termDays) || input.termDays < 1 || input.termDays > MAX_TERM_DAYS)) {
    throw new CustomerCreditError(`Betaaltermijn moet een geheel aantal dagen zijn (1–${MAX_TERM_DAYS}).`);
  }
  const gid = await profileCustomerGid(profileId);
  const before = await readCustomerCreditRaw(gid);
  if (!before) throw new CustomerCreditError("Klant niet gevonden in Shopify.", 404);

  await writeCustomerCredit(gid, input);

  const after = await readCustomerCreditRaw(gid);
  const view = toView(gid, after?.creditAllowed ?? null, after?.termDays ?? null);
  if (view.creditAllowed !== input.creditAllowed || (input.termDays !== null && view.storedTermDays !== input.termDays)) {
    throw new CustomerCreditError("Shopify bevestigt de nieuwe instelling niet — probeer het opnieuw.", 502);
  }
  await logAudit({
    userId: actor.id,
    action: "customer_credit.updated",
    entityType: "ShopifyCustomer",
    entityId: gid,
    metadata: {
      customerProfileId: profileId,
      before: { creditAllowed: before.creditAllowed, termDays: before.termDays },
      after: { creditAllowed: String(input.creditAllowed), termDays: input.termDays === null ? null : String(input.termDays) },
    },
  });
  return view;
}
