import "server-only";
import { normalizeEmail } from "@/lib/email";
import { graphGet, type GraphCredential } from "./graph-client";
import type { EmailMailboxAdapter, EmailMailboxAdapterStatus, NormalizedEmailMessage, NormalizedEmailParticipant } from "./types";

// Microsoft 365 / Exchange Online mailbox adapter, via Microsoft Graph
// (docs/platform-discovery/30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md §3).
// One instance per monitored Microsoft 365 mailbox (Phase 3C-A: exactly
// info@stones4u.nl). Read-only — Mail.Read (Application) only, no write
// scope requested anywhere in this file.
//
// Direction is determined reliably (unlike TelefoonSysteem's calls, which
// have no direction signal at all): /users/{mailbox}/messages returns both
// received and sent items for that one mailbox, so comparing the message's
// `from` address to the mailbox's own address tells INBOUND from OUTBOUND
// with certainty — never a guess.

const MAX_RESULTS = 25;

type GraphEmailAddress = { address?: string; name?: string };
type GraphRecipient = { emailAddress?: GraphEmailAddress };
type GraphMessage = {
  id: string;
  conversationId?: string | null;
  subject?: string | null;
  from?: GraphRecipient | null;
  toRecipients?: GraphRecipient[] | null;
  ccRecipients?: GraphRecipient[] | null;
  sentDateTime?: string | null;
  receivedDateTime?: string | null;
  bodyPreview?: string | null;
  webLink?: string | null;
};
type GraphMessagesResponse = { value: GraphMessage[] };

const SELECT_FIELDS = "id,conversationId,subject,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,bodyPreview,webLink";

/** Builds the Graph $search KQL expression. Rejects (returns null) an
 * address containing a double quote rather than interpolating it unescaped
 * into the query string — normalizeEmail()'s shape check already makes this
 * vanishingly unlikely, this is defense-in-depth, not the primary guard. */
function buildSearchQuery(address: string): string | null {
  if (address.includes('"')) return null;
  return `"from:${address} OR to:${address} OR cc:${address}"`;
}

function toParticipant(recipient: GraphRecipient | null | undefined): NormalizedEmailParticipant | null {
  const address = normalizeEmail(recipient?.emailAddress?.address);
  if (!address) return null;
  return { address, name: recipient?.emailAddress?.name ?? null };
}

function toParticipants(recipients: GraphRecipient[] | null | undefined): NormalizedEmailParticipant[] {
  return (recipients ?? []).map(toParticipant).filter((p): p is NormalizedEmailParticipant => p !== null);
}

export class Microsoft365EmailAdapter implements EmailMailboxAdapter {
  readonly provider = "MICROSOFT365" as const;

  constructor(
    readonly mailboxId: string,
    readonly mailboxAddress: string,
    private readonly credential: GraphCredential,
  ) {}

  status(): EmailMailboxAdapterStatus {
    return { available: true };
  }

  async searchMessagesForAddresses(addresses: string[]): Promise<NormalizedEmailMessage[]> {
    const uniqueAddresses = [...new Set(addresses.map(normalizeEmail).filter((a): a is string => !!a))];
    if (uniqueAddresses.length === 0) return [];

    const results = await Promise.allSettled(uniqueAddresses.map((address) => this.fetchMessages(address)));

    const byId = new Map<string, NormalizedEmailMessage>();
    for (const result of results) {
      if (result.status !== "fulfilled") {
        console.error("microsoft365_email_fetch_failed", result.reason);
        continue;
      }
      for (const message of result.value) byId.set(message.externalMessageId, message);
    }

    return [...byId.values()].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  }

  private async fetchMessages(address: string): Promise<NormalizedEmailMessage[]> {
    const searchQuery = buildSearchQuery(address);
    if (!searchQuery) return [];

    const path =
      `/users/${encodeURIComponent(this.mailboxAddress)}/messages` +
      `?$search=${encodeURIComponent(searchQuery)}&$select=${SELECT_FIELDS}&$top=${MAX_RESULTS}`;

    const body = await graphGet<GraphMessagesResponse>(path, this.credential, {
      ConsistencyLevel: "eventual",
      // Stable IDs across folder moves/certain forwarding scenarios — see
      // docs/platform-discovery/30 §8 "stable external ID".
      Prefer: 'IdType="ImmutableId"',
    });
    if (!body) return [];

    return body.value.map((message) => this.toNormalized(message)).filter((m): m is NormalizedEmailMessage => m !== null);
  }

  private toNormalized(message: GraphMessage): NormalizedEmailMessage | null {
    const from = toParticipant(message.from);
    // A message with no resolvable, normalizable `from` address cannot be
    // assigned a direction with any certainty — skip it rather than guess.
    if (!from) return null;

    const mailboxAddressNormalized = normalizeEmail(this.mailboxAddress);
    const direction = from.address === mailboxAddressNormalized ? "OUTBOUND" : "INBOUND";
    const occurredAtRaw = direction === "OUTBOUND" ? message.sentDateTime ?? message.receivedDateTime : message.receivedDateTime ?? message.sentDateTime;
    const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : null;
    if (!occurredAt || Number.isNaN(occurredAt.getTime())) return null;

    return {
      provider: "MICROSOFT365",
      mailboxId: this.mailboxId,
      mailboxAddress: this.mailboxAddress,
      externalMessageId: message.id,
      conversationId: message.conversationId ?? null,
      subject: message.subject ?? null,
      from,
      to: toParticipants(message.toRecipients),
      cc: toParticipants(message.ccRecipients),
      occurredAt,
      direction,
      bodyPreview: message.bodyPreview ?? null,
      webLink: message.webLink ?? null,
    };
  }
}
