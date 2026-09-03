// Shared, provider-independent types for the Phase 3C email integration
// (docs/platform-discovery/30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md).
// Every provider adapter (Microsoft365EmailAdapter, the future
// ImapEmailAdapter) normalizes into exactly this shape — nothing outside
// this file (and the per-provider adapter files themselves) is allowed to
// know a Graph message shape from an IMAP one.

export type EmailDirection = "INBOUND" | "OUTBOUND";
export type EmailProviderName = "MICROSOFT365" | "IMAP";

export type NormalizedEmailParticipant = {
  /** Always run through normalizeEmail() before landing here — never a raw,
   * un-normalized address. */
  address: string;
  name: string | null;
};

export type NormalizedEmailMessage = {
  provider: EmailProviderName;
  /** MonitoredMailbox.id — CRM-internal, never a provider-native mailbox
   * identifier. Used to build collision-proof timeline IDs (ADR-008). */
  mailboxId: string;
  mailboxAddress: string;
  externalMessageId: string;
  conversationId: string | null;
  subject: string | null;
  from: NormalizedEmailParticipant;
  to: NormalizedEmailParticipant[];
  cc: NormalizedEmailParticipant[];
  occurredAt: Date;
  direction: EmailDirection;
  bodyPreview: string | null;
  webLink: string | null;
};

/** The one place this short-prefix mapping is defined — used both for the
 * Activity Timeline's synthetic id (src/modules/activity/timeline.ts) and
 * for the ExternalContactMatch.externalRef recorded by the composing
 * EmailAdapter (adapter.ts), so the two are never allowed to drift into two
 * different naming schemes for the same message
 * (docs/platform-discovery/30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md §8). */
export function stableEmailId(message: Pick<NormalizedEmailMessage, "provider" | "mailboxId" | "externalMessageId">): string {
  const prefix = message.provider === "MICROSOFT365" ? "m365" : "imap";
  return `${prefix}-${message.mailboxId}-${message.externalMessageId}`;
}

export type EmailMailboxAdapterStatus =
  | { available: true }
  | { available: false; reason: string };

/** Per-mailbox adapter interface — implemented once per provider
 * (Microsoft365EmailAdapter, ImapEmailAdapter). Never seen outside
 * src/integrations/email/ — the composing EmailAdapter (adapter.ts) is the
 * only thing that talks to these. */
export interface EmailMailboxAdapter {
  readonly mailboxId: string;
  readonly mailboxAddress: string;
  readonly provider: EmailProviderName;
  status(): EmailMailboxAdapterStatus;
  /** Read-only. Returns messages where `address` appears as a participant
   * (from/to/cc), for exactly this one mailbox. Must never throw — an
   * unreachable/misconfigured mailbox returns [] (see each adapter's own
   * fail-safe handling), matching every other Phase 3 adapter in this
   * codebase. */
  searchMessagesForAddresses(addresses: string[]): Promise<NormalizedEmailMessage[]>;
}
