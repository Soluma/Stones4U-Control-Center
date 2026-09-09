import "server-only";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { generatePublicToken, hashPublicToken } from "./token";
import { DeliveryHandoffError } from "./errors";
import { mirrorRequestedDeliveryDateToShopify } from "@/integrations/shopify/draft-order-mirror";
import type { DeliveryDateHandoff, PaymentProvider } from "@/generated/prisma";

// Quote Delivery Date Handoff — native Control Center implementation
// (docs/QUOTE-DELIVERY-DATE-PORTAL-BUILD.md). DeliveryDateHandoff is a
// lightweight reference to an external commercial object (currently always
// a Shopify Draft Order — Phase A has no OfferteApp/s4u-quote-app
// dependency), never a copy of it — same pattern as
// OpportunityExternalLink/ExternalContactMatch.

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar-day comparison, ignoring time/zone — dates are always
 * stored/compared as bare YYYY-MM-DD, never a timestamp. */
function toDateOnlyUTC(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function todayUTC(): Date {
  const now = new Date();
  return toDateOnlyUTC(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
}

function toIsoDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Server-side date validation — a valid calendar date, not in the past.
 * Deliberately no weekend/holiday/lead-time/capacity/routing rules (Phase A
 * scope boundary, docs/QUOTE-DELIVERY-DATE-PORTAL-BUILD.md).
 */
export function parseRequestedDeliveryDate(raw: string | null | undefined): Date {
  if (!raw || raw.trim() === "") {
    throw new DeliveryHandoffError("Kies een gewenste leverdatum.");
  }
  const trimmed = raw.trim();
  if (!DATE_ONLY_RE.test(trimmed)) {
    throw new DeliveryHandoffError("Ongeldige datum.");
  }
  const parts = trimmed.split("-").map(Number);
  const parsed = toDateOnlyUTC(parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0);
  // Reject e.g. 2026-02-30 — Date's constructor silently rolls over an
  // out-of-range day/month into the next one instead of erroring, so the
  // round-trip below is the actual validity check.
  if (toIsoDateOnly(parsed) !== trimmed) {
    throw new DeliveryHandoffError("Ongeldige datum.");
  }
  if (parsed.getTime() < todayUTC().getTime()) {
    throw new DeliveryHandoffError("Kies een datum die niet in het verleden ligt.");
  }
  return parsed;
}

/**
 * Staff-facing creation — always authenticated (called from Customer 360 /
 * a Draft Order context, never from the public route). Phase A only ever
 * creates SHOPIFY-sourced rows: externalId = shopifyDraftOrderGid (the two
 * are identical today — see schema.prisma comment on DeliveryDateHandoff).
 * Idempotent per (sourceSystem, externalId): calling this again for the
 * same Draft Order returns the existing row instead of creating a
 * duplicate (matches the @@unique constraint) and does NOT reissue a new
 * public token — a previously shared link keeps working.
 */
export async function createDeliveryDateHandoff(input: {
  shopifyDraftOrderGid: string;
  customerProfileId?: string | null;
  paymentProvider?: PaymentProvider;
  createdById: string;
}): Promise<{ handoff: DeliveryDateHandoff; rawToken: string | null }> {
  const existing = await prisma.deliveryDateHandoff.findUnique({
    where: { sourceSystem_externalId: { sourceSystem: "SHOPIFY", externalId: input.shopifyDraftOrderGid } },
  });
  if (existing) {
    // No raw token to return — only the hash is stored, by design (§ token
    // security). The caller must have preserved the original link/token
    // themselves if they need to share it again.
    return { handoff: existing, rawToken: null };
  }

  const rawToken = generatePublicToken();
  const publicTokenHash = hashPublicToken(rawToken);

  const handoff = await prisma.deliveryDateHandoff.create({
    data: {
      publicTokenHash,
      sourceSystem: "SHOPIFY",
      externalId: input.shopifyDraftOrderGid,
      shopifyDraftOrderGid: input.shopifyDraftOrderGid,
      customerProfileId: input.customerProfileId ?? null,
      paymentProvider: input.paymentProvider ?? "SHOPIFY",
      createdById: input.createdById,
    },
  });

  await logAudit({
    userId: input.createdById,
    action: "delivery_handoff.created",
    entityType: "DeliveryDateHandoff",
    entityId: handoff.id,
    metadata: { shopifyDraftOrderGid: input.shopifyDraftOrderGid, customerProfileId: input.customerProfileId ?? null },
  });

  return { handoff, rawToken };
}

/** Read-only, for Customer 360's backoffice display — only rows that
 * resolved to this customer (never a live Shopify/quote call, matches
 * QuotesTable/DraftOrdersTable convention of reading only what's already
 * known locally or fetched separately). */
export async function listDeliveryDateHandoffsForCustomer(customerProfileId: string): Promise<DeliveryDateHandoff[]> {
  return prisma.deliveryDateHandoff.findMany({
    where: { customerProfileId },
    orderBy: { updatedAt: "desc" },
  });
}

export type DeliveryDateHandoffWithCustomer = DeliveryDateHandoff & {
  customerProfile: { id: string; displayName: string | null; companyName: string | null } | null;
};

/** Read-only, for the Phase 5A staff management view — every handoff
 * (portal-wide, not customer-scoped), newest-updated first. */
export async function listAllDeliveryDateHandoffs(limit = 50): Promise<DeliveryDateHandoffWithCustomer[]> {
  return prisma.deliveryDateHandoff.findMany({
    orderBy: { updatedAt: "desc" },
    take: limit,
    include: { customerProfile: { select: { id: true, displayName: true, companyName: true } } },
  });
}

/** Read-only — resolves a Shopify Customer GID to an existing
 * CustomerProfile.id, or null. NEVER creates a CustomerProfile (that is
 * syncCustomerIdentityFromShopify()'s job, in the CRM module, and is
 * deliberately not called from here — a delivery-date handoff must never
 * fabricate a customer record purely to have someone to link to,
 * docs/QUOTE-DELIVERY-DATE-MANUAL-ACTIVATION.md §4). */
export async function resolveCustomerProfileIdForShopifyGid(shopifyCustomerGid: string | null | undefined): Promise<string | null> {
  if (!shopifyCustomerGid) return null;
  const profile = await prisma.customerProfile.findUnique({
    where: { shopifyCustomerGid },
    select: { id: true },
  });
  return profile?.id ?? null;
}

/**
 * Staff-facing token reissue. The raw token is never retrievable after
 * creation (only its hash is stored) — this is the safe recovery path
 * when staff loses a link before sharing it: generate a brand-new raw
 * token, overwrite publicTokenHash on the SAME row (never a new row —
 * (sourceSystem, externalId) stays unique, requestedDeliveryDate/status/
 * shopifyDraftOrderGid all untouched), which permanently invalidates the
 * old link. Throws Prisma's standard "record not found" (mapped to 404 by
 * toErrorResponse()) for an unknown handoffId.
 */
export async function regeneratePublicToken(handoffId: string, actorId: string): Promise<{ handoff: DeliveryDateHandoff; rawToken: string }> {
  const rawToken = generatePublicToken();
  const publicTokenHash = hashPublicToken(rawToken);

  const handoff = await prisma.deliveryDateHandoff.update({
    where: { id: handoffId },
    data: { publicTokenHash },
  });

  await logAudit({
    userId: actorId,
    action: "delivery_handoff.token_regenerated",
    entityType: "DeliveryDateHandoff",
    entityId: handoff.id,
    metadata: { shopifyDraftOrderGid: handoff.shopifyDraftOrderGid },
  });

  return { handoff, rawToken };
}

/** Public, unauthenticated lookup — resolves a raw bearer token to its
 * DeliveryDateHandoff row, or null for any unknown/malformed token
 * (callers must always respond with the same generic 404 regardless of
 * *why* it didn't resolve, never revealing whether a differently-shaped
 * token might exist). */
export async function getHandoffByRawToken(rawToken: string): Promise<DeliveryDateHandoff | null> {
  if (!rawToken) return null;
  const publicTokenHash = hashPublicToken(rawToken);
  return prisma.deliveryDateHandoff.findUnique({ where: { publicTokenHash } });
}

type SubmitResult = { redirectUrl: string };

/**
 * Full public POST orchestration, in the exact required order:
 * validate → persist locally → mirror to Shopify → resolve payment target
 * → (caller redirects). Never redirects before a successful mirror; a
 * mirror failure leaves the locally persisted date untouched and throws a
 * retryable DeliveryHandoffError instead of returning a target.
 */
export async function submitRequestedDeliveryDate(handoff: DeliveryDateHandoff, rawDateInput: string | null | undefined): Promise<SubmitResult> {
  const requestedDate = parseRequestedDeliveryDate(rawDateInput);
  const dateIso = toIsoDateOnly(requestedDate);

  const dateChanged =
    !handoff.requestedDeliveryDate || toIsoDateOnly(new Date(handoff.requestedDeliveryDate)) !== dateIso;

  const persisted = await prisma.deliveryDateHandoff.update({
    where: { id: handoff.id },
    data: { requestedDeliveryDate: requestedDate },
  });

  if (dateChanged && persisted.customerProfileId) {
    await prisma.activity.create({
      data: {
        customerProfileId: persisted.customerProfileId,
        type: "DELIVERY_DATE_REQUESTED",
        sourceType: "CONTROL_CENTER",
        title: "Gewenste leverdatum klant ontvangen",
        summary: `Klant koos ${dateIso} als gewenste leverdatum (wens, geen toezegging).`,
        occurredAt: new Date(),
        actorId: null,
        relatedDeliveryDateHandoffId: persisted.id,
      },
    });
  }

  await logAudit({
    userId: null,
    action: "delivery_handoff.date_requested",
    entityType: "DeliveryDateHandoff",
    entityId: persisted.id,
    metadata: { dateChanged },
  });

  // Mirror to Shopify — required in Phase A (every handoff is
  // SHOPIFY-sourced and always carries a shopifyDraftOrderGid). A missing
  // shopifyDraftOrderGid would be a genuine data-integrity bug, not a
  // normal "not linked yet" state (unlike OfferteApp, where a Quote can
  // exist before any Draft Order does) — fail loudly rather than silently
  // skipping the mirror.
  if (!persisted.shopifyDraftOrderGid) {
    throw new DeliveryHandoffError("Deze betaallink is niet meer geldig. Neem contact op met Stones4U.", {
      retryable: false,
    });
  }

  let mirrorResult;
  try {
    mirrorResult = await mirrorRequestedDeliveryDateToShopify(persisted.shopifyDraftOrderGid, dateIso);
  } catch (error) {
    const errorCode = error instanceof Error ? error.name : "UNKNOWN_ERROR";
    await prisma.deliveryDateHandoff.update({
      where: { id: persisted.id },
      data: { status: "ERROR", mirrorErrorCode: errorCode },
    });
    await logAudit({
      userId: null,
      action: "delivery_handoff.mirror_failed",
      entityType: "DeliveryDateHandoff",
      entityId: persisted.id,
      metadata: { errorCode },
    });
    throw new DeliveryHandoffError("Kon uw leverdatum nog niet doorgeven aan het bestelsysteem. Probeer het opnieuw.", {
      retryable: true,
    });
  }

  await prisma.deliveryDateHandoff.update({
    where: { id: persisted.id },
    data: { status: "MIRRORED", lastMirrorAt: new Date(), mirrorErrorCode: null },
  });

  return resolvePaymentTarget(persisted, mirrorResult.invoiceUrl);
}

/**
 * Server-authoritative payment-target resolution — never influenced by
 * anything from the request. Phase A supports only the Shopify path;
 * MOLLIE fails closed with a clear "not supported yet" message rather than
 * silently falling back to Shopify or trusting any client-supplied URL
 * (docs/QUOTE-DELIVERY-DATE-PORTAL-DISCOVERY.md §8).
 */
function resolvePaymentTarget(handoff: DeliveryDateHandoff, invoiceUrl: string | null): SubmitResult {
  if (handoff.paymentProvider === "MOLLIE") {
    throw new DeliveryHandoffError(
      "Online betalen via Mollie is voor deze offerte nog niet beschikbaar in dit portaal. Neem contact op met Stones4U.",
      { retryable: false },
    );
  }
  if (handoff.paymentProvider === "UNKNOWN") {
    throw new DeliveryHandoffError("Deze betaallink is niet meer geldig. Neem contact op met Stones4U.", {
      retryable: false,
    });
  }
  if (!invoiceUrl) {
    throw new DeliveryHandoffError("Deze betaallink is niet meer geldig. Neem contact op met Stones4U.", {
      retryable: true,
    });
  }
  return { redirectUrl: invoiceUrl };
}
