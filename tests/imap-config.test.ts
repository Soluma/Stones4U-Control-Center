import { beforeEach, describe, expect, it } from "vitest";
import { createImapConfig } from "@/integrations/email/imap-config";

const ENV_KEYS = ["IMAP_HOST", "IMAP_PORT", "IMAP_SECURE", "IMAP_USERNAME", "IMAP_PASSWORD", "IMAP_SENT_MAILBOX"] as const;

function setEnv() {
  process.env.IMAP_HOST = "mail.xel.nl";
  process.env.IMAP_PORT = "993";
  process.env.IMAP_USERNAME = "info@stones4u.eu";
  process.env.IMAP_PASSWORD = "test-password";
}

describe("createImapConfig", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("returns null when required env vars are unset", () => {
    expect(createImapConfig()).toBeNull();
  });

  it("returns null when only some required env vars are set", () => {
    process.env.IMAP_HOST = "mail.xel.nl";
    process.env.IMAP_PORT = "993";
    expect(createImapConfig()).toBeNull();
  });

  it("returns a config with secure defaulting to true when IMAP_SECURE is unset", () => {
    setEnv();
    expect(createImapConfig()).toEqual({
      host: "mail.xel.nl",
      port: 993,
      secure: true,
      username: "info@stones4u.eu",
      password: "test-password",
      sentMailboxOverride: undefined,
    });
  });

  it("respects an explicit IMAP_SECURE=false", () => {
    setEnv();
    process.env.IMAP_SECURE = "false";
    expect(createImapConfig()?.secure).toBe(false);
  });

  it("treats any value other than the literal 'false' as secure:true", () => {
    setEnv();
    process.env.IMAP_SECURE = "true";
    expect(createImapConfig()?.secure).toBe(true);
  });

  it("returns null for a non-numeric or non-positive port", () => {
    setEnv();
    process.env.IMAP_PORT = "not-a-number";
    expect(createImapConfig()).toBeNull();

    process.env.IMAP_PORT = "0";
    expect(createImapConfig()).toBeNull();
  });

  it("includes the sent-mailbox override only when explicitly set", () => {
    setEnv();
    process.env.IMAP_SENT_MAILBOX = "INBOX.Verzonden Items";
    expect(createImapConfig()?.sentMailboxOverride).toBe("INBOX.Verzonden Items");
  });
});
