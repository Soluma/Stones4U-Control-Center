import "server-only";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { generatePublicToken, hashPublicToken } from "./token";
import { DeliveryHandoffError, ExistingRequestedDeliveryDateError } from "./errors";
import { mirrorRequestedDeliveryDateToShopify } from "@/integrations/shopify/draft-order-mirror";
import { mirrorRequestedDeliveryDateToOrder } from "@/integrations/shopify/order-mirror";
import { OrderCancelledError } from "@/integrations/shopify/errors";
import { getOrderForHandoff } from "@/integrations/shopify/order-for-handoff";
import type { DeliveryDateHandoff, PaymentProvider } from "@/generated/prisma";

// Quote Delivery Date Handoff — native Control Center implementation
// (docs/QUOTE-DELIVERY-DATE-PORTAL-BUILD.md). DeliveryDateHandoff is a
// lightweight reference to an external commercial object (currently always
// a Shopify Draft Order — Phase A has no OfferteApp/s4u-quote-app
// dependency), never a copy of it — same pattern as
// OpportunityExternalLink/ExternalContactMatch.

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Generous — real Shopify order names are short ("#1234", "#WEB1234"), this
// only guards against something unexpectedly long ever reaching the
// column, not against legitimate order-naming schemes.
const PUBLIC_REFERENCE_MAX_LENGTH = 64;

/** publicReference always originates server-side from Shopify's own
 * order/draft name — never client-supplied. Trims whitespace, collapses an
 * empty/whitespace-only value to null (never stores ""), and caps length
 * defensively. Deliberately no other normalization (no character
 * stripping) — Shopify order-naming schemes are configurable per shop and
 * must not be second-guessed here. Rendering (Phase 6D) is plain React
 * text interpolation, never dangerouslySetInnerHTML — no HTML-escaping
 * needed here either. */
function normalizePublicReference(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, PUBLIC_REFERENCE_MAX_LENGTH);
}

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

/**
 * Phase 6B — Order-equivalent of createDeliveryDateHandoff(). Deliberately
 * a separate function, not a branch inside the Draft one: distinct input
 * shape (no paymentProvider concept — see submitRequestedDeliveryDateForOrder()
 * for why), distinct commerceObjectType/shopifyOrderGid fields to set, and
 * keeping the two apart means the existing, already-proven Draft path is
 * never touched by this change (docs/ORDER-DELIVERY-HANDOFF-FOUNDATION.md
 * §"Service abstraction").
 *
 * Idempotent per (sourceSystem, externalId) — identical guarantee to the
 * Draft version, via the same existing unique constraint (a Draft GID and
 * an Order GID never collide as strings, so no new constraint was needed).
 * Not yet called from anywhere in this phase — no staff UI, no webhook,
 * no automatic eligibility trigger (Phase 6B is foundation only).
 */
export async function createOrGetOrderDeliveryHandoff(input: {
  shopifyOrderGid: string;
  publicReference?: string | null;
  customerProfileId?: string | null;
  createdById: string;
}): Promise<{ handoff: DeliveryDateHandoff; rawToken: string | null }> {
  const existing = await prisma.deliveryDateHandoff.findUnique({
    where: { sourceSystem_externalId: { sourceSystem: "SHOPIFY", externalId: input.shopifyOrderGid } },
  });
  if (existing) {
    return { handoff: existing, rawToken: null };
  }

  const rawToken = generatePublicToken();
  const publicTokenHash = hashPublicToken(rawToken);

  const handoff = await prisma.deliveryDateHandoff.create({
    data: {
      publicTokenHash,
      sourceSystem: "SHOPIFY",
      externalId: input.shopifyOrderGid,
      commerceObjectType: "SHOPIFY_ORDER",
      shopifyOrderGid: input.shopifyOrderGid,
      publicReference: normalizePublicReference(input.publicReference),
      customerProfileId: input.customerProfileId ?? null,
      // No payment-provider concept for the Order-based flow — the
      // requested-delivery-date preference is deliberately decoupled from
      // payment/invoicing (docs/ORDER-DELIVERY-HANDOFF-FOUNDATION.md
      // §"B2B boundary"). UNKNOWN also fails resolvePaymentTarget() closed
      // if that Draft-only function were ever mistakenly called for an
      // Order row — see submitRequestedDeliveryDateForOrder(), which never
      // calls it at all.
      paymentProvider: "UNKNOWN",
      createdById: input.createdById,
    },
  });

  await logAudit({
    userId: input.createdById,
    action: "delivery_handoff.created",
    entityType: "DeliveryDateHandoff",
    entityId: handoff.id,
    metadata: { shopifyOrderGid: input.shopifyOrderGid, customerProfileId: input.customerProfileId ?? null },
  });

  return { handoff, rawToken };
}

/**
 * Phase 6E — the staff-facing entry point for creating an Order handoff
 * from the /delivery-handoffs management UI. Deliberately the only path
 * that may call createOrGetOrderDeliveryHandoff() from a staff action: a
 * search result the staff member is acting on can be stale by the time
 * they click "create" (another tab, another staff member, time passing —
 * build instruction §6, "the known stale-search problem"), so this always
 * re-reads the specific Order fresh via getOrderForHandoff() first and
 * derives every trusted field from *that* read — publicReference,
 * cancellation state, and the customer GID used for matching — never from
 * whatever the client's search result happened to show. The caller may
 * supply nothing but which Order was selected (by GID) and, when needed,
 * a narrow confirmation flag; it has no way to supply a publicReference, a
 * customerProfileId, or a commerceObjectType.
 *
 * Refuses to create a new handoff for a cancelled Order (build instruction
 * §7) with a staff-friendly, non-retryable DeliveryHandoffError — a
 * historical handoff for that Order, if one already exists, is untouched
 * and stays readable (this function only ever reaches the cancelled check
 * before creating; an existing row is never deleted or hidden by it). This
 * check runs first and wins even over an explicit confirmation, per the
 * newly clarified business rule below (build instruction §6).
 *
 * **Existing requested_delivery_date is not exclusively portal-generated**
 * (clarified by Fons, this round): a Shopify Order can already carry
 * `requested_delivery_date` before any Control Center handoff ever
 * existed — entered during an earlier quote, on the Draft Order, by staff
 * manually, or through some other approved process. Discovering that
 * value on re-read must NEVER be read as "the customer already used the
 * portal" — it only proves "Stones4U already knows a requested delivery
 * date," nothing about where it came from. So: if no *local* handoff
 * exists yet for this Order and Shopify already has a date, this function
 * refuses to silently create a second, competing request — it throws
 * `ExistingRequestedDeliveryDateError` (carrying the actual date value)
 * unless the caller explicitly passes
 * `confirmExistingRequestedDeliveryDate: true`. That flag authorizes
 * exactly one thing — "staff knowingly wants a new handoff despite a
 * known date" — and nothing else; it never substitutes for the mandatory
 * fresh Shopify re-read above, and has no bearing on Order identity,
 * publicReference, customerProfileId, or commerceObjectType, all of which
 * remain server-derived exactly as before.
 *
 * This confirmation requirement applies ONLY to a *first* handoff for the
 * Order — an existing local handoff always takes the normal idempotent
 * path below regardless of what Shopify currently shows (build
 * instruction §7): a customer who already used their link, then staff
 * revisiting the management page, must never be asked to "confirm"
 * anything just because the date they already submitted is, unsurprisingly,
 * still on the Order.
 */
export async function createOrderDeliveryHandoffForStaff(input: {
  orderGid: string;
  createdById: string;
  confirmExistingRequestedDeliveryDate?: boolean;
}): Promise<{ handoff: DeliveryDateHandoff; rawToken: string | null }> {
  const order = await getOrderForHandoff(input.orderGid);
  if (!order) {
    throw new DeliveryHandoffError("Deze bestelling is niet gevonden in Shopify.", { retryable: false });
  }
  if (order.isCancelled) {
    throw new DeliveryHandoffError(
      "Voor een geannuleerde bestelling kan geen nieuwe leverdatumlink worden aangemaakt.",
      { retryable: false },
    );
  }

  const existingLocalHandoff = await prisma.deliveryDateHandoff.findUnique({
    where: { sourceSystem_externalId: { sourceSystem: "SHOPIFY", externalId: order.gid } },
  });

  if (!existingLocalHandoff && order.requestedDeliveryDate && !input.confirmExistingRequestedDeliveryDate) {
    throw new ExistingRequestedDeliveryDateError(order.requestedDeliveryDate);
  }

  const customerProfileId = await resolveCustomerProfileIdForShopifyGid(order.customerGid);

  return createOrGetOrderDeliveryHandoff({
    shopifyOrderGid: order.gid,
    publicReference: order.name,
    customerProfileId,
    createdById: input.createdById,
  });
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
    // Phase 6E — this function already worked for any handoff row
    // (Draft or Order alike; it only ever touches publicTokenHash), but
    // the audit trail previously logged only the Draft GID field, always
    // null for an Order row. Logging both makes the trail meaningful for
    // either type without changing any actual regeneration behavior.
    metadata: { shopifyDraftOrderGid: handoff.shopifyDraftOrderGid, shopifyOrderGid: handoff.shopifyOrderGid },
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

type OrderSubmitResult = { requestedDeliveryDate: string };

/**
 * Phase 6B — Order-equivalent of submitRequestedDeliveryDate(). A separate
 * function, not a branch inside the Draft one, on purpose: the Draft
 * version's contract (persist → mirror → resolvePaymentTarget() →
 * redirectUrl) doesn't apply here at all — an Order-based handoff is
 * deliberately decoupled from payment/invoicing status (that decoupling is
 * the entire point of moving this to a real Order — see
 * docs/ORDER-DELIVERY-HANDOFF-FOUNDATION.md §"B2B boundary"). This
 * function therefore never calls resolvePaymentTarget() and never returns
 * a redirectUrl — only enough for a future success page (Phase 6D) to
 * render. Keeping the two functions fully separate, rather than adding a
 * branch to the existing one, means submitRequestedDeliveryDate() and its
 * existing test coverage are untouched by this change.
 *
 * Same validate → persist → mirror ordering guarantee as the Draft
 * version: never marks MIRRORED before a successful mirror; a mirror
 * failure leaves the locally persisted date untouched and throws a
 * retryable DeliveryHandoffError. Same DELIVERY_DATE_REQUESTED Activity
 * rule — only on a genuinely new/changed date, never on a same-date
 * resubmit.
 */
export async function submitRequestedDeliveryDateForOrder(
  handoff: DeliveryDateHandoff,
  rawDateInput: string | null | undefined,
): Promise<OrderSubmitResult> {
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

  // Mirror to Shopify — a missing shopifyOrderGid on a commerceObjectType
  // = SHOPIFY_ORDER row would be a genuine data-integrity bug, not a
  // normal state — fail loudly rather than silently skipping the mirror
  // (same reasoning as the Draft version's shopifyDraftOrderGid check).
  if (!persisted.shopifyOrderGid) {
    throw new DeliveryHandoffError("Deze link is niet meer geldig. Neem contact op met Stones4U.", {
      retryable: false,
    });
  }

  try {
    await mirrorRequestedDeliveryDateToOrder(persisted.shopifyOrderGid, dateIso);
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
    // A cancelled Order will never succeed on retry — fail closed with a
    // clear, non-retryable message rather than implying the customer's
    // date was (or could still be) accepted (build instruction §10).
    // Every other mirror failure is treated as transient/retryable, same
    // as the Draft flow.
    if (error instanceof OrderCancelledError) {
      throw new DeliveryHandoffError("Deze bestelling is geannuleerd. Neem contact op met Stones4U.", {
        retryable: false,
      });
    }
    throw new DeliveryHandoffError("Kon uw leverdatum nog niet doorgeven aan het bestelsysteem. Probeer het opnieuw.", {
      retryable: true,
    });
  }

  await prisma.deliveryDateHandoff.update({
    where: { id: persisted.id },
    data: { status: "MIRRORED", lastMirrorAt: new Date(), mirrorErrorCode: null },
  });

  return { requestedDeliveryDate: dateIso };
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
