import "server-only";
import { ImapFlow, AuthenticationFailure, type SearchObject, type FetchMessageObject } from "imapflow";
import { normalizeEmail } from "@/lib/email";
import { findInlineTextPart, decodeBodyPartPreview } from "./imap-mime";
import type { ImapConnectionConfig } from "./imap-config";
import type { EmailDirection, EmailMailboxAdapter, EmailMailboxAdapterStatus, NormalizedEmailMessage, NormalizedEmailParticipant } from "./types";

// IMAP mailbox adapter — Phase 3C-B, info@stones4u.eu via Xel
// (docs/build/PHASE-3C-B-IMAP-STAGING.md). Strictly read-only: every fetch
// ImapFlow issues for body content uses BODY.PEEK under the hood (verified
// against ImapFlow's own command builder, lib/commands/fetch.js — PEEK
// never sets \Seen), and this file never issues a STORE/EXPUNGE/COPY/MOVE/
// APPEND/CREATE command — only connect, list, search, fetch, logout.
//
// A fresh connection is opened per call and always closed in a `finally` —
// no long-lived pooled connection, matching the "fetch fresh per Customer
// 360 page load" pattern already used by every other Phase 3 adapter.

const CONNECT_TIMEOUT_MS = 8_000;
const SOCKET_TIMEOUT_MS = 15_000;
const MAX_RESULTS_PER_MAILBOX = 25;
// Byte cap on the raw (still-encoded) text part fetched for a preview —
// generous enough to survive quoted-printable/base64 overhead for a normal
// paragraph, small enough that even a maliciously large message can never
// turn one preview into a meaningful memory/bandwidth cost. Never used for
// attachments — only the one inline text part identified via BODYSTRUCTURE
// is ever fetched.
const BODY_PART_FETCH_CAP_BYTES = 8_192;

function imapOptions(config: ImapConnectionConfig) {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.username, pass: config.password },
    logger: false as const,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    // Deliberately no `tls` override — Node's `tls.ConnectionOptions`
    // default (rejectUnauthorized: true, i.e. certificate verification ON)
    // is left untouched. Never set `tls: { rejectUnauthorized: false }`.
  };
}

function toParticipant(name: string | undefined, address: string | undefined): NormalizedEmailParticipant | null {
  const normalized = normalizeEmail(address);
  if (!normalized) return null;
  return { address: normalized, name: name ?? null };
}

function toParticipants(list: { name?: string; address?: string }[] | undefined): NormalizedEmailParticipant[] {
  return (list ?? []).map((r) => toParticipant(r.name, r.address)).filter((p): p is NormalizedEmailParticipant => p !== null);
}

export class ImapEmailAdapter implements EmailMailboxAdapter {
  readonly provider = "IMAP" as const;

  constructor(
    readonly mailboxId: string,
    readonly mailboxAddress: string,
    private readonly config: ImapConnectionConfig,
  ) {}

  status(): EmailMailboxAdapterStatus {
    return { available: true };
  }

  async searchMessagesForAddresses(addresses: string[]): Promise<NormalizedEmailMessage[]> {
    const uniqueAddresses = [...new Set(addresses.map(normalizeEmail).filter((a): a is string => !!a))];
    if (uniqueAddresses.length === 0) return [];

    const client = new ImapFlow(imapOptions(this.config));

    try {
      await client.connect();
    } catch (error) {
      const reason = error instanceof AuthenticationFailure ? "imap_auth_failed" : "imap_connect_failed";
      console.error(reason, this.mailboxAddress, error instanceof Error ? error.message : "unknown");
      return [];
    }

    try {
      const inbound = await this.searchMailbox(client, "INBOX", uniqueAddresses, "INBOUND");

      const sentMailbox = await this.resolveSentMailbox(client);
      const outbound = sentMailbox ? await this.searchMailbox(client, sentMailbox, uniqueAddresses, "OUTBOUND") : [];
      if (!sentMailbox) {
        console.error("imap_sent_mailbox_unavailable", this.mailboxAddress);
      }

      return [...inbound, ...outbound]
        .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
        .slice(0, MAX_RESULTS_PER_MAILBOX);
    } catch (error) {
      console.error("imap_search_failed", this.mailboxAddress, error instanceof Error ? error.message : "unknown");
      return [];
    } finally {
      try {
        await client.logout();
      } catch {
        // Server may have already closed the connection — not actionable,
        // and must never surface as a failure of the read itself.
      }
    }
  }

  /** Server-confirmed SPECIAL-USE (\Sent) discovery only — never a
   * name-guessed folder. Falls back to the explicit env override; if
   * neither resolves, Sent is treated as unavailable (outbound mail simply
   * isn't found) rather than picking an arbitrary mailbox. */
  private async resolveSentMailbox(client: ImapFlow): Promise<string | null> {
    if (this.config.sentMailboxOverride) return this.config.sentMailboxOverride;

    try {
      const list = await client.list();
      const sent = list.find((mb) => mb.specialUse === "\\Sent" && mb.specialUseSource === "extension");
      if (sent) return sent.path;

      // Inventory only — never a guess (docs/build/PHASE-3C-B-IMAP-STAGING.md
      // §5 "kies geen willekeurige map").
      console.error("imap_sent_mailbox_not_confirmed", this.mailboxAddress, JSON.stringify(list.map((mb) => ({ path: mb.path, specialUse: mb.specialUse, specialUseSource: mb.specialUseSource }))));
      return null;
    } catch (error) {
      console.error("imap_list_failed", this.mailboxAddress, error instanceof Error ? error.message : "unknown");
      return null;
    }
  }

  private async searchMailbox(client: ImapFlow, mailboxPath: string, addresses: string[], direction: EmailDirection): Promise<NormalizedEmailMessage[]> {
    let lock;
    try {
      lock = await client.getMailboxLock(mailboxPath);
    } catch (error) {
      console.error("imap_mailbox_lock_failed", mailboxPath, error instanceof Error ? error.message : "unknown");
      return [];
    }

    try {
      const uidValidity = client.mailbox ? client.mailbox.uidValidity : null;
      if (uidValidity === null) return [];

      // Server-side SEARCH FROM/TO/CC is substring-ish and provider-
      // dependent — used only to pull CANDIDATES. Every candidate is
      // re-validated locally against the exact normalized address before
      // it is ever treated as a real match (see filterExact* below).
      const searchQuery: SearchObject =
        direction === "INBOUND"
          ? addresses.length === 1
            ? { from: addresses[0]! }
            : { or: addresses.map((a) => ({ from: a })) }
          : { or: addresses.flatMap((a) => [{ to: a }, { cc: a }]) };

      const uids = await client.search(searchQuery, { uid: true });
      if (!uids || uids.length === 0) return [];

      // IMAP UIDs are assigned in arrival order, so the highest UIDs are
      // the most recent — take the tail rather than fetching envelopes for
      // the entire (possibly large) candidate set.
      const recentUids = uids.slice(-MAX_RESULTS_PER_MAILBOX);

      const envelopes: FetchMessageObject[] = [];
      for await (const message of client.fetch(recentUids, { uid: true, envelope: true, bodyStructure: true }, { uid: true })) {
        envelopes.push(message);
      }

      const messages: NormalizedEmailMessage[] = [];
      for (const raw of envelopes) {
        try {
          const message = await this.toNormalized(client, raw, mailboxPath, direction, addresses, uidValidity);
          if (message) messages.push(message);
        } catch (error) {
          // One malformed message must never fail the whole mailbox query.
          console.error("imap_message_parse_failed", mailboxPath, raw.uid, error instanceof Error ? error.message : "unknown");
        }
      }
      return messages;
    } finally {
      lock.release();
    }
  }

  private async toNormalized(
    client: ImapFlow,
    raw: FetchMessageObject,
    mailboxPath: string,
    direction: EmailDirection,
    queryAddresses: string[],
    uidValidity: bigint,
  ): Promise<NormalizedEmailMessage | null> {
    const envelope = raw.envelope;
    if (!envelope) return null;

    const [from] = toParticipants(envelope.from);
    if (!from) return null; // no resolvable sender — never guess a participant

    const to = toParticipants(envelope.to);
    const cc = toParticipants(envelope.cc);

    // Local exact re-validation (docs/build/PHASE-3C-B-IMAP-STAGING.md §5) —
    // the IMAP-side search already narrowed candidates, but this is the
    // actual authority: a query address must appear as a literal,
    // normalized participant in the field direction implies, or this
    // message is discarded even though the server returned it.
    const isRealMatch =
      direction === "INBOUND"
        ? queryAddresses.includes(from.address)
        : [...to, ...cc].some((p) => queryAddresses.includes(p.address));
    if (!isRealMatch) return null;

    const occurredAtRaw = envelope.date ?? (raw.internalDate as Date | string | undefined);
    const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : null;
    if (!occurredAt || Number.isNaN(occurredAt.getTime())) return null;

    const bodyPreview = await this.fetchPreview(client, raw, mailboxPath);

    return {
      provider: "IMAP",
      mailboxId: this.mailboxId,
      mailboxAddress: this.mailboxAddress,
      // Compound so the shared stableEmailId()/ExternalContactMatch.externalRef
      // helper (types.ts) naturally produces imap-{mailboxId}-{uidValidity}-{uid}
      // without any change to that shared, already-tested helper — UID
      // alone is not enough identity (docs/build/PHASE-3C-B-IMAP-STAGING.md
      // §9), UIDVALIDITY must be part of it.
      externalMessageId: `${uidValidity}-${raw.uid}`,
      conversationId: null, // IMAP has no native thread id equivalent to Graph's conversationId — never fabricated
      subject: envelope.subject ?? null,
      from,
      to,
      cc,
      occurredAt,
      direction,
      bodyPreview,
      webLink: null, // no known safe Xel webmail deep-link pattern
    };
  }

  private async fetchPreview(client: ImapFlow, raw: FetchMessageObject, mailboxPath: string): Promise<string | null> {
    const textPart = findInlineTextPart(raw.bodyStructure);
    if (!textPart) return null;

    try {
      const fetched = await client.fetchOne(
        String(raw.uid),
        { bodyParts: [{ key: textPart.part, maxLength: BODY_PART_FETCH_CAP_BYTES }] },
        { uid: true },
      );
      if (!fetched) return null;
      const buffer = fetched.bodyParts?.get(textPart.part);
      if (!buffer) return null;
      return await decodeBodyPartPreview(buffer, textPart);
    } catch (error) {
      console.error("imap_preview_fetch_failed", mailboxPath, raw.uid, error instanceof Error ? error.message : "unknown");
      return null;
    }
  }
}

/** Deliberately unavailable — no host/config known yet, or Phase 3C-B has
 * not been enabled for this mailbox. Never a network call, never implies
 * the mailbox already works. */
export class DisabledImapEmailAdapter implements EmailMailboxAdapter {
  readonly provider = "IMAP" as const;

  constructor(
    readonly mailboxId: string,
    readonly mailboxAddress: string,
    private reason: string = "IMAP-koppeling is nog niet geconfigureerd (IMAP_HOST/IMAP_PORT/IMAP_USERNAME/IMAP_PASSWORD ontbreken).",
  ) {}

  status(): EmailMailboxAdapterStatus {
    return { available: false, reason: this.reason };
  }

  async searchMessagesForAddresses(): Promise<NormalizedEmailMessage[]> {
    return [];
  }
}
