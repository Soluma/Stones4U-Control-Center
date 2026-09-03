import "server-only";
import { prisma } from "@/platform/db/prisma";
import { normalizeEmail } from "@/lib/email";
import { resolveAndRecordByEmail } from "@/modules/matching/matching.service";
import { createGraphCredential } from "./graph-client";
import { Microsoft365EmailAdapter } from "./microsoft365-adapter";
import { ImapEmailAdapter, DisabledImapEmailAdapter } from "./imap-adapter";
import { createImapConfig } from "./imap-config";
import type { EmailMailboxAdapter, EmailMailboxAdapterStatus, EmailProviderName, NormalizedEmailMessage } from "./types";

// Provider-independent, composing EmailAdapter
// (docs/platform-discovery/30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md §1) —
// the only thing Customer 360 / the Activity Timeline ever import from
// src/integrations/email. Reads active MonitoredMailbox rows, instantiates
// the right per-provider EmailMailboxAdapter for each (Microsoft365EmailAdapter
// or the disabled IMAP placeholder), and queries all of them in parallel via
// Promise.allSettled — one mailbox failing (wrong RBAC scope, Graph outage,
// missing credential) never blocks another (§10 fail-safe requirement).

export type EmailAdapterStatus = { available: true } | { available: false; reason: string };

export interface EmailAdapter {
  status(): EmailAdapterStatus;
  /** Read-only. Returns messages across every enabled, available mailbox
   * where any of `addresses` is a participant, newest first. Never throws —
   * an unreachable/unconfigured mailbox contributes nothing, silently. As a
   * side effect, records a system-suggested ExternalContactMatch
   * (MatchSource.EMAIL) for each DISTINCT external contact-address found
   * across this batch of messages — see recordMatchesForMessages() below;
   * this is a passive suggestion, never a confirmed/definitive match
   * (ADR-007 rule 2), and is not gated by role — the same way viewing a
   * customer's Shopify snapshot already triggers an unconfirmed profile
   * refresh today. */
  getMessagesForAddresses(addresses: string[]): Promise<NormalizedEmailMessage[]>;
}

export class DisabledEmailAdapter implements EmailAdapter {
  constructor(private reason: string = "E-mailintegratie is niet geconfigureerd.") {}

  status(): EmailAdapterStatus {
    return { available: false, reason: this.reason };
  }

  async getMessagesForAddresses(): Promise<NormalizedEmailMessage[]> {
    return [];
  }
}

/** Wraps a configured MonitoredMailbox row that has no working credential
 * yet (e.g. a MICROSOFT365 row present but MICROSOFT_GRAPH_* env vars
 * unset) — distinct from DisabledImapEmailAdapter, which is Phase 3C-B's
 * permanent, expected state rather than a configuration gap. */
class UnavailableMailboxAdapter implements EmailMailboxAdapter {
  constructor(
    readonly mailboxId: string,
    readonly mailboxAddress: string,
    readonly provider: EmailProviderName,
    private reason: string,
  ) {}

  status(): EmailMailboxAdapterStatus {
    return { available: false, reason: this.reason };
  }

  async searchMessagesForAddresses(): Promise<NormalizedEmailMessage[]> {
    return [];
  }
}

const MAX_MATCHED_ADDRESSES_PER_LOAD = 25;

/** Applies ADR-007 to the DISTINCT external (customer-side) participant
 * addresses found across every message in this load — never the mailbox's
 * own address, never a fuzzy name match, never per-message.
 *
 * externalRef here is the CONTACT IDENTITY being matched (a normalized
 * email address) — never a message-scoped id. That is a deliberate,
 * corrected distinction from an earlier version of this function, which
 * used stableEmailId(message) (a per-message id) as externalRef and so
 * created one ExternalContactMatch row per email instead of one per
 * distinct contact address — see docs/architecture/ADR-007-CUSTOMER-MATCHING-LAYER.md
 * (2026-09-03 correction) and docs/build/PHASE-3C-B-EMAIL-MATCH-FIX.md.
 * stableEmailId() remains exactly as it was, unused here — it is the
 * Timeline's interaction-scoped projection id (ADR-008 §category B), a
 * different concept that must never be reused for matching identity.
 *
 * Deduping addresses across the whole batch (not per message) means a
 * customer with 25 emails from the same address now produces exactly one
 * resolveAndRecordByEmail() call, matching ADR-007 rule 4's intended
 * upsert-idempotency ("hetzelfde adres, herhaalde matching-run -> geen
 * nieuwe rij") instead of one call per message. A failure here never
 * blocks message display — matching is a best-effort side effect of a
 * read, not something the read depends on. */
export async function recordMatchesForMessages(messages: NormalizedEmailMessage[]): Promise<void> {
  const externalAddresses = new Set<string>();

  for (const message of messages) {
    const mailboxAddress = normalizeEmail(message.mailboxAddress);
    const candidates = message.direction === "INBOUND" ? [message.from] : [...message.to, ...message.cc];

    for (const participant of candidates) {
      // Defense-in-depth: NormalizedEmailParticipant.address is documented
      // as always pre-normalized by the producing adapter (types.ts), but
      // this Set is what ultimately becomes ExternalContactMatch.externalRef
      // — the value a uniqueness constraint depends on. Re-normalizing here
      // costs nothing (idempotent) and guarantees two differently-cased/
      // spaced forms of the same address can never diverge into two rows,
      // even if a future adapter ever violates that contract.
      const normalized = normalizeEmail(participant.address);
      if (normalized && normalized !== mailboxAddress) externalAddresses.add(normalized);
    }
  }

  for (const address of [...externalAddresses].slice(0, MAX_MATCHED_ADDRESSES_PER_LOAD)) {
    try {
      await resolveAndRecordByEmail(address, "EMAIL", address);
    } catch (error) {
      console.error("email_match_record_failed", error instanceof Error ? error.message : "unknown");
    }
  }
}

class ComposingEmailAdapter implements EmailAdapter {
  constructor(private mailboxAdapters: EmailMailboxAdapter[]) {}

  status(): EmailAdapterStatus {
    if (this.mailboxAdapters.some((a) => a.status().available)) return { available: true };
    const reasons = this.mailboxAdapters
      .map((a) => a.status())
      .filter((s): s is { available: false; reason: string } => !s.available)
      .map((s) => s.reason);
    return { available: false, reason: reasons[0] ?? "Geen enkele mailbox is beschikbaar." };
  }

  async getMessagesForAddresses(addresses: string[]): Promise<NormalizedEmailMessage[]> {
    const uniqueAddresses = [...new Set(addresses.filter(Boolean))];
    if (uniqueAddresses.length === 0) return [];

    const results = await Promise.allSettled(this.mailboxAdapters.map((a) => a.searchMessagesForAddresses(uniqueAddresses)));

    const messages: NormalizedEmailMessage[] = [];
    for (const result of results) {
      if (result.status !== "fulfilled") {
        console.error("email_mailbox_fetch_failed", result.reason);
        continue;
      }
      messages.push(...result.value);
    }
    messages.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

    try {
      await recordMatchesForMessages(messages);
    } catch (error) {
      // recordMatchesForMessages already catches per-participant — this is
      // an extra safety net, never allowed to affect what's returned.
      console.error("email_match_pass_failed", error instanceof Error ? error.message : "unknown");
    }

    return messages;
  }
}

export async function createEmailAdapter(): Promise<EmailAdapter> {
  const mailboxRows = await prisma.monitoredMailbox.findMany({
    where: { enabled: true },
    orderBy: { emailAddress: "asc" },
  });
  if (mailboxRows.length === 0) {
    return new DisabledEmailAdapter("Geen mailboxen geconfigureerd.");
  }

  // Each provider's configuration is independent — Microsoft 365 being
  // unconfigured (parked, per Phase 3C-B's explicit scope) never affects
  // whether IMAP works, and vice versa (§10 fail-safe requirement).
  const graphCredential = createGraphCredential();
  const imapConfig = createImapConfig();

  const mailboxAdapters: EmailMailboxAdapter[] = mailboxRows.map((row) => {
    if (row.provider === "MICROSOFT365") {
      if (!graphCredential) {
        return new UnavailableMailboxAdapter(
          row.id,
          row.emailAddress,
          "MICROSOFT365",
          "Microsoft Graph-credentials zijn niet geconfigureerd (MICROSOFT_GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET).",
        );
      }
      return new Microsoft365EmailAdapter(row.id, row.emailAddress, graphCredential);
    }
    // provider === "IMAP" — Phase 3C-B (info@stones4u.eu via Xel).
    if (!imapConfig) {
      return new DisabledImapEmailAdapter(row.id, row.emailAddress);
    }
    return new ImapEmailAdapter(row.id, row.emailAddress, imapConfig);
  });

  return new ComposingEmailAdapter(mailboxAdapters);
}
