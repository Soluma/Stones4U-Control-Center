import "server-only";

// IMAP connection config for Phase 3C-B (info@stones4u.eu, provider Xel) —
// docs/build/PHASE-3C-B-IMAP-STAGING.md. Read-only, server-side only —
// never a database row (docs/platform-discovery/30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md
// §5), never logged, never sent to the browser.

export type ImapConnectionConfig = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  /** Explicit override for the Sent folder path — only used when automatic
   * SPECIAL-USE (\Sent) discovery does not find a server-confirmed match
   * (see imap-adapter.ts resolveSentMailbox()). Never a guessed folder
   * name picked by this codebase. */
  sentMailboxOverride?: string;
};

export function createImapConfig(): ImapConnectionConfig | null {
  const host = process.env.IMAP_HOST;
  const portRaw = process.env.IMAP_PORT;
  const username = process.env.IMAP_USERNAME;
  const password = process.env.IMAP_PASSWORD;
  if (!host || !portRaw || !username || !password) return null;

  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) return null;

  // Implicit TLS by default — an explicit "false" is required to disable
  // it, so a missing/misspelled env var never silently degrades to
  // plaintext.
  const secure = process.env.IMAP_SECURE !== "false";

  return {
    host,
    port,
    secure,
    username,
    password,
    sentMailboxOverride: process.env.IMAP_SENT_MAILBOX || undefined,
  };
}
