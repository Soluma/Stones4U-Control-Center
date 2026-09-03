// Phase 4C — pure, in-memory timeline naming enrichment
// (docs/platform-discovery/38-PHASE-4C-CONTACTS-ARCHITECTURE.md §12). No
// database access, no new external call — the caller (timeline.ts) already
// has both the already-fetched active CustomerContact list and the
// already-fetched email/call data; this module only decides which contact
// name, if any, to attach. Mirrors the pattern already used for Phase 4B's
// Shopify/quote attention signals (src/modules/opportunities/attention.ts).

export type ContactIdentity = {
  id: string;
  displayName: string;
  emailNormalized: string | null;
  phoneNormalized: string | null;
};

/** Never guesses: if the identity matches more than one active contact
 * (a shared address within the same customer), returns null rather than
 * picking one arbitrarily (ADR-010 §4 — person-level ambiguity is a valid,
 * safe outcome). Callers must only ever pass ACTIVE contacts — an archived
 * contact must never become the automatically-displayed name (build
 * instruction §8 scenario E / §25). */
export function matchContactByEmail(contacts: ContactIdentity[], normalizedEmail: string | null): ContactIdentity | null {
  if (!normalizedEmail) return null;
  const matches = contacts.filter((c) => c.emailNormalized === normalizedEmail);
  return matches.length === 1 ? matches[0]! : null;
}

/** Same as matchContactByEmail, keyed on a normalized phone number. */
export function matchContactByPhone(contacts: ContactIdentity[], normalizedPhone: string | null): ContactIdentity | null {
  if (!normalizedPhone) return null;
  const matches = contacts.filter((c) => c.phoneNormalized === normalizedPhone);
  return matches.length === 1 ? matches[0]! : null;
}
