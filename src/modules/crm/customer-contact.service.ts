import "server-only";
import { Prisma } from "@/generated/prisma";
import type { Role } from "@/generated/prisma";
import { prisma } from "@/platform/db/prisma";
import { logAudit } from "@/platform/audit/audit";
import { ForbiddenError } from "@/platform/auth/guards";
import { normalizeEmail } from "@/lib/email";
import { normalizeDutchPhone } from "@/lib/phone";

// CustomerContact service (docs/architecture/ADR-010-CUSTOMER-CONTACT-MODEL.md,
// docs/platform-discovery/38-PHASE-4C-CONTACTS-ARCHITECTURE.md,
// docs/platform-discovery/39-PHASE-4C-BUILD-SPEC.md). CustomerContact is
// Control-Center-owned CRM data (never a Shopify mirror) — a shared
// "company directory" record, so unlike Note there is no author-only edit
// restriction: any ADMIN/AGENT may create/edit/archive/restore any
// customer's contacts (architecture doc §15).

type Actor = { id: string; role: Role };

export class CustomerContactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerContactValidationError";
  }
}

export type DuplicateWarning = { field: "email" | "phone"; conflictingContactId: string } | null;

function assertWriteAccess(actor: Actor) {
  if (actor.role === "VIEWER") {
    throw new ForbiddenError("Alleen schrijfgerechtigde gebruikers mogen contactpersonen beheren.");
  }
}

/** Empty/whitespace-only input normalizes to null (build spec §2 — "lege
 * string normaliseer professioneel naar null"); a non-empty value that
 * fails to normalize is a hard validation error (never silently dropped or
 * coerced) — same discipline as opportunity.service.ts's money validation. */
function prepareEmail(raw: string | null | undefined): { email: string | null; emailNormalized: string | null } {
  if (raw === undefined || raw === null) return { email: null, emailNormalized: null };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { email: null, emailNormalized: null };
  const normalized = normalizeEmail(trimmed);
  if (!normalized) throw new CustomerContactValidationError("Ongeldig e-mailadres.");
  return { email: trimmed, emailNormalized: normalized };
}

function preparePhone(raw: string | null | undefined): { phone: string | null; phoneNormalized: string | null } {
  if (raw === undefined || raw === null) return { phone: null, phoneNormalized: null };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { phone: null, phoneNormalized: null };
  const normalized = normalizeDutchPhone(trimmed);
  if (!normalized) throw new CustomerContactValidationError("Ongeldig telefoonnummer.");
  return { phone: trimmed, phoneNormalized: normalized };
}

/** Non-blocking duplicate detection, scoped to one customer only — a
 * shared general address (info@bedrijf.nl for two colleagues) is legitimate
 * (architecture doc §16), so this never blocks, only warns. Cross-customer
 * duplicates are never checked here (a normal, expected scenario). */
async function detectDuplicate(
  customerProfileId: string,
  emailNormalized: string | null,
  phoneNormalized: string | null,
  excludeContactId?: string,
): Promise<DuplicateWarning> {
  if (emailNormalized) {
    const conflict = await prisma.customerContact.findFirst({
      where: {
        customerProfileId,
        archivedAt: null,
        emailNormalized,
        ...(excludeContactId ? { id: { not: excludeContactId } } : {}),
      },
      select: { id: true },
    });
    if (conflict) return { field: "email", conflictingContactId: conflict.id };
  }
  if (phoneNormalized) {
    const conflict = await prisma.customerContact.findFirst({
      where: {
        customerProfileId,
        archivedAt: null,
        phoneNormalized,
        ...(excludeContactId ? { id: { not: excludeContactId } } : {}),
      },
      select: { id: true },
    });
    if (conflict) return { field: "phone", conflictingContactId: conflict.id };
  }
  return null;
}

/** Wraps the primary-set transaction — translates the partial unique index
 * violation (prisma/migrations/20260903174521_.../migration.sql,
 * "CustomerContact_one_active_primary_per_customer") into a clean,
 * catchable validation error instead of an unhandled 500. This is the true
 * concurrency race the transaction alone cannot close (build instruction
 * §3): two simultaneous requests can each observe "no active primary yet"
 * before either commits. */
async function runPrimaryTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(fn);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new CustomerContactValidationError(
        "Er is net al een ander contact primair gemaakt bij deze klant — probeer het opnieuw.",
      );
    }
    throw error;
  }
}

export type CreateContactInput = {
  customerProfileId: string;
  displayName: string;
  jobTitle?: string | null;
  email?: string | null;
  phone?: string | null;
  isPrimary?: boolean;
  isDecisionMaker?: boolean;
  isBillingContact?: boolean;
};

export async function createContact(
  input: CreateContactInput,
  actor: Actor,
): Promise<{ contact: Awaited<ReturnType<typeof prisma.customerContact.create>>; duplicateWarning: DuplicateWarning }> {
  assertWriteAccess(actor);

  const displayName = input.displayName.trim();
  if (displayName.length === 0) throw new CustomerContactValidationError("Naam is verplicht.");

  const { email, emailNormalized } = prepareEmail(input.email);
  const { phone, phoneNormalized } = preparePhone(input.phone);

  const duplicateWarning = await detectDuplicate(input.customerProfileId, emailNormalized, phoneNormalized);

  const isPrimary = !!input.isPrimary;
  const contact = await runPrimaryTransaction(async (tx) => {
    if (isPrimary) {
      await tx.customerContact.updateMany({
        where: { customerProfileId: input.customerProfileId, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    return tx.customerContact.create({
      data: {
        customerProfileId: input.customerProfileId,
        displayName,
        jobTitle: input.jobTitle?.trim() || null,
        email,
        emailNormalized,
        phone,
        phoneNormalized,
        isPrimary,
        isDecisionMaker: !!input.isDecisionMaker,
        isBillingContact: !!input.isBillingContact,
        createdById: actor.id,
      },
    });
  });

  await logAudit({
    userId: actor.id,
    action: "customer_contact.created",
    entityType: "CustomerContact",
    entityId: contact.id,
    metadata: { customerProfileId: input.customerProfileId, displayName },
  });
  if (isPrimary) {
    await logAudit({
      userId: actor.id,
      action: "customer_contact.primary_changed",
      entityType: "CustomerContact",
      entityId: contact.id,
      metadata: { customerProfileId: input.customerProfileId },
    });
  }

  return { contact, duplicateWarning };
}

export type UpdateContactInput = {
  displayName?: string;
  jobTitle?: string | null;
  email?: string | null;
  phone?: string | null;
  isPrimary?: boolean;
  isDecisionMaker?: boolean;
  isBillingContact?: boolean;
};

/** `customerProfileId` is required and enforced here — never trust a route
 * param alone: a contact belonging to a different customer than the one in
 * the URL must come back as "not found" (P2025 -> 404 via toErrorResponse),
 * never a silent cross-customer mutation (build spec §18, a hard gate). */
export async function updateContact(
  customerProfileId: string,
  contactId: string,
  changes: UpdateContactInput,
  actor: Actor,
): Promise<{ contact: Awaited<ReturnType<typeof prisma.customerContact.update>>; duplicateWarning: DuplicateWarning }> {
  assertWriteAccess(actor);

  const existing = await prisma.customerContact.findFirstOrThrow({ where: { id: contactId, customerProfileId } });

  const displayName = changes.displayName !== undefined ? changes.displayName.trim() : existing.displayName;
  if (displayName.length === 0) throw new CustomerContactValidationError("Naam is verplicht.");

  const emailFields = changes.email !== undefined ? prepareEmail(changes.email) : { email: existing.email, emailNormalized: existing.emailNormalized };
  const phoneFields = changes.phone !== undefined ? preparePhone(changes.phone) : { phone: existing.phone, phoneNormalized: existing.phoneNormalized };

  const duplicateWarning = await detectDuplicate(existing.customerProfileId, emailFields.emailNormalized, phoneFields.phoneNormalized, contactId);

  const becomingPrimary = changes.isPrimary === true && !existing.isPrimary;

  const contact = await runPrimaryTransaction(async (tx) => {
    if (becomingPrimary) {
      await tx.customerContact.updateMany({
        where: { customerProfileId: existing.customerProfileId, isPrimary: true, id: { not: contactId } },
        data: { isPrimary: false },
      });
    }
    return tx.customerContact.update({
      where: { id: contactId },
      data: {
        displayName,
        jobTitle: changes.jobTitle !== undefined ? changes.jobTitle?.trim() || null : undefined,
        email: emailFields.email,
        emailNormalized: emailFields.emailNormalized,
        phone: phoneFields.phone,
        phoneNormalized: phoneFields.phoneNormalized,
        isPrimary: changes.isPrimary,
        isDecisionMaker: changes.isDecisionMaker,
        isBillingContact: changes.isBillingContact,
      },
    });
  });

  await logAudit({
    userId: actor.id,
    action: "customer_contact.updated",
    entityType: "CustomerContact",
    entityId: contact.id,
    metadata: { customerProfileId: existing.customerProfileId },
  });
  if (becomingPrimary) {
    await logAudit({
      userId: actor.id,
      action: "customer_contact.primary_changed",
      entityType: "CustomerContact",
      entityId: contact.id,
      metadata: { customerProfileId: existing.customerProfileId },
    });
  }

  return { contact, duplicateWarning };
}

/** Idempotent, same precedent as Opportunity's markWon/markLost — a repeat
 * archive call is a no-op, never a duplicate audit row. Clears isPrimary
 * (build instruction §4: "bij archive: isPrimary = false. Geen automatische
 * promotie van een ander contact.") — the customer can be left without an
 * active primary contact; that is a valid, expected state. */
export async function archiveContact(customerProfileId: string, contactId: string, actor: Actor) {
  assertWriteAccess(actor);

  const existing = await prisma.customerContact.findFirstOrThrow({ where: { id: contactId, customerProfileId } });
  if (existing.archivedAt) return existing;

  const contact = await prisma.customerContact.update({
    where: { id: contactId },
    data: { archivedAt: new Date(), isPrimary: false },
  });

  await logAudit({
    userId: actor.id,
    action: "customer_contact.archived",
    entityType: "CustomerContact",
    entityId: contact.id,
    metadata: { customerProfileId: existing.customerProfileId },
  });

  return contact;
}

/** Idempotent. Never auto-restores isPrimary — build instruction §4: "Bij
 * restore: contact wordt NIET automatisch opnieuw primary. Gebruiker kan
 * dat expliciet instellen. Dit voorkomt verrassende side effects." A
 * separate updateContact({ isPrimary: true }) call is required afterward if
 * desired. */
export async function restoreContact(customerProfileId: string, contactId: string, actor: Actor) {
  assertWriteAccess(actor);

  const existing = await prisma.customerContact.findFirstOrThrow({ where: { id: contactId, customerProfileId } });
  if (!existing.archivedAt) return existing;

  const contact = await prisma.customerContact.update({
    where: { id: contactId },
    data: { archivedAt: null },
  });

  await logAudit({
    userId: actor.id,
    action: "customer_contact.restored",
    entityType: "CustomerContact",
    entityId: contact.id,
    metadata: { customerProfileId: existing.customerProfileId },
  });

  return contact;
}

/** Active contacts first (primary, then alphabetical); archived only when
 * explicitly requested (architecture doc §6 "primair contact eerst
 * gesorteerd", build instruction §15 "archived alleen via expliciete
 * show/filter"). */
export async function listContactsForCustomer(customerProfileId: string, opts: { includeArchived?: boolean } = {}) {
  return prisma.customerContact.findMany({
    where: { customerProfileId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ isPrimary: "desc" }, { displayName: "asc" }],
  });
}

/** Command-palette contact search (architecture doc §13) — searches only
 * CustomerContact's own fields (name/email/phone/job title), never the
 * customer's own name (that's the existing `customers` search group).
 * take: limit, indexed columns — no heavy query. */
export async function searchCustomerContacts(term: string, limit = 8) {
  return prisma.customerContact.findMany({
    where: {
      archivedAt: null,
      OR: [
        { displayName: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
        { phone: { contains: term, mode: "insensitive" } },
        { jobTitle: { contains: term, mode: "insensitive" } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    include: { customerProfile: { select: { id: true, displayName: true, companyName: true } } },
  });
}

/** Cross-customer-relation invariant enforcement, used by Task/Note/
 * Appointment when a caller supplies both a customerContactId and a
 * (possibly opportunity-derived) customerProfileId — architecture doc §11,
 * build instruction §20/§21/§22: "Server bepaalt/valideert dit", never
 * trusted from the caller, never a silent mismatch. */
export async function assertContactBelongsToCustomer(customerContactId: string, customerProfileId: string): Promise<void> {
  const contact = await prisma.customerContact.findUniqueOrThrow({
    where: { id: customerContactId },
    select: { customerProfileId: true },
  });
  if (contact.customerProfileId !== customerProfileId) {
    throw new CustomerContactValidationError("Deze contactpersoon hoort niet bij deze klant.");
  }
}
