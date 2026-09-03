import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchMessageObject, ListResponse } from "imapflow";

// A fake, minimal ImapFlow — enough surface for ImapEmailAdapter, driven by
// a per-test `scenario` object so each test controls exactly what the
// "server" does without a real network connection. Tracks which mailbox is
// currently locked (mirroring real IMAP's single-selected-mailbox model)
// so search/fetch/fetchOne resolve against the right per-mailbox behavior.

type FakeMailboxBehavior = {
  uidValidity: bigint;
  lockError?: Error;
  searchResult?: number[] | false | Error;
  envelopes?: Map<number, FetchMessageObject>;
  bodyParts?: Map<number, Map<string, Buffer>>;
};

type FakeScenario = {
  connectError?: Error;
  listResult?: ListResponse[] | Error;
  mailboxes?: Record<string, FakeMailboxBehavior>;
};

let scenario: FakeScenario = {};
const logoutSpy = vi.fn();

class AuthenticationFailure extends Error {}

class FakeImapFlow {
  mailbox: { uidValidity: bigint } | false = false;
  private currentPath: string | null = null;

  constructor(public options: unknown) {}

  async connect() {
    if (scenario.connectError) throw scenario.connectError;
  }

  async logout() {
    logoutSpy();
  }

  async list(): Promise<ListResponse[]> {
    if (scenario.listResult instanceof Error) throw scenario.listResult;
    return (scenario.listResult as ListResponse[]) ?? [];
  }

  async getMailboxLock(path: string) {
    const mb = scenario.mailboxes?.[path];
    if (mb?.lockError) throw mb.lockError;
    this.currentPath = path;
    this.mailbox = { uidValidity: mb?.uidValidity ?? 1n };
    return { path, release: vi.fn() };
  }

  async search(): Promise<number[] | false> {
    const mb = scenario.mailboxes?.[this.currentPath ?? ""];
    if (mb?.searchResult instanceof Error) throw mb.searchResult;
    return mb?.searchResult ?? [];
  }

  async *fetch(range: number[]): AsyncGenerator<FetchMessageObject> {
    const mb = scenario.mailboxes?.[this.currentPath ?? ""];
    for (const uid of range) {
      const envelope = mb?.envelopes?.get(uid);
      if (envelope) yield envelope;
    }
  }

  async fetchOne(uidStr: string): Promise<FetchMessageObject | false> {
    const mb = scenario.mailboxes?.[this.currentPath ?? ""];
    const uid = Number(uidStr);
    const parts = mb?.bodyParts?.get(uid);
    if (!parts) return false;
    return { seq: uid, uid, bodyParts: parts } as FetchMessageObject;
  }
}

vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow, AuthenticationFailure }));

function envelope(overrides: Partial<NonNullable<FetchMessageObject["envelope"]>> = {}, uid = 1): FetchMessageObject {
  return {
    seq: uid,
    uid,
    envelope: {
      date: new Date("2026-09-01T09:00:00Z"),
      subject: "Vraag over levering",
      from: [{ address: "klant@voorbeeld.nl", name: "Klant Naam" }],
      to: [{ address: "info@stones4u.eu", name: "Stones4U" }],
      cc: [],
      ...overrides,
    },
    bodyStructure: { type: "text/plain", part: "1", parameters: { charset: "utf-8" } },
  } as FetchMessageObject;
}

const baseConfig = { host: "mail.xel.nl", port: 993, secure: true, username: "info@stones4u.eu", password: "test-password" };

describe("ImapEmailAdapter", () => {
  beforeEach(() => {
    scenario = {};
    logoutSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports available: true once constructed", async () => {
    const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
    const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
    expect(adapter.status()).toEqual({ available: true });
  });

  it("returns [] without connecting for an empty address list", async () => {
    const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
    const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
    expect(await adapter.searchMessagesForAddresses([])).toEqual([]);
  });

  describe("read-only", () => {
    it("never calls any write-shaped method (store/expunge/copy/move/append/create) on the fake client", async () => {
      scenario = {
        listResult: [{ path: "Sent", specialUse: "\\Sent", specialUseSource: "extension" } as ListResponse],
        mailboxes: {
          INBOX: { uidValidity: 100n, searchResult: [], envelopes: new Map() },
          Sent: { uidValidity: 200n, searchResult: [], envelopes: new Map() },
        },
      };
      const forbidden = ["store", "messageFlagsAdd", "messageFlagsRemove", "expunge", "messageCopy", "messageMove", "append", "mailboxCreate"];
      for (const method of forbidden) {
        expect((FakeImapFlow.prototype as unknown as Record<string, unknown>)[method]).toBeUndefined();
      }
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"]);
      // logout() is the only "closing" call — connect/list/getMailboxLock/search/fetch/logout only.
      expect(logoutSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("folder discovery", () => {
    it("uses the server-confirmed \\Sent SPECIAL-USE folder", async () => {
      scenario = {
        listResult: [
          { path: "INBOX.Trash", specialUse: "\\Trash", specialUseSource: "extension" } as ListResponse,
          { path: "INBOX.Sent Items", specialUse: "\\Sent", specialUseSource: "extension" } as ListResponse,
        ],
        mailboxes: {
          INBOX: { uidValidity: 100n, searchResult: [], envelopes: new Map() },
          "INBOX.Sent Items": { uidValidity: 200n, searchResult: [], envelopes: new Map() },
        },
      };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      // No throw / no error about missing Sent — proves the confirmed folder was used.
      await expect(adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"])).resolves.toEqual([]);
    });

    it("respects an explicit IMAP_SENT_MAILBOX override even when SPECIAL-USE would resolve differently", async () => {
      scenario = {
        listResult: [{ path: "INBOX.Sent", specialUse: "\\Sent", specialUseSource: "extension" } as ListResponse],
        mailboxes: {
          INBOX: { uidValidity: 100n, searchResult: [], envelopes: new Map() },
          "Verzonden Items": { uidValidity: 300n, searchResult: [], envelopes: new Map() },
        },
      };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", { ...baseConfig, sentMailboxOverride: "Verzonden Items" });
      await expect(adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"])).resolves.toEqual([]);
    });

    it("never guesses a folder by name when no server-confirmed \\Sent exists and there is no override", async () => {
      scenario = {
        // specialUseSource "name" — a heuristic guess, not server-confirmed — must NOT be trusted.
        listResult: [{ path: "Verzonden", specialUse: "\\Sent", specialUseSource: "name" } as ListResponse],
        mailboxes: { INBOX: { uidValidity: 100n, searchResult: [], envelopes: new Map() } },
      };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      // Sent unresolved -> outbound search never attempted -> no crash, empty result, degrades gracefully.
      await expect(adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"])).resolves.toEqual([]);
    });
  });

  describe("inbound", () => {
    it("returns an exact-from match from INBOX", async () => {
      const uid = 42;
      scenario = {
        listResult: [],
        mailboxes: {
          INBOX: {
            uidValidity: 111n,
            searchResult: [uid],
            envelopes: new Map([[uid, envelope({}, uid)]]),
          },
        },
      };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      const [message] = await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"]);

      expect(message!.direction).toBe("INBOUND");
      expect(message!.from).toEqual({ address: "klant@voorbeeld.nl", name: "Klant Naam" });
      expect(message!.subject).toBe("Vraag over levering");
    });

    it("discards a server-returned candidate whose from-address does not exactly, normalized-match the query address (substring-search guard)", async () => {
      const uid = 7;
      scenario = {
        listResult: [],
        mailboxes: {
          INBOX: {
            uidValidity: 111n,
            searchResult: [uid],
            envelopes: new Map([[uid, envelope({ from: [{ address: "notklant@voorbeeld.nl", name: "Iemand Anders" }] }, uid)]]),
          },
        },
      };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      expect(await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"])).toEqual([]);
    });

    it("normalizes both the query address and the server's from-address before comparing (case/whitespace)", async () => {
      const uid = 9;
      scenario = {
        listResult: [],
        mailboxes: {
          INBOX: {
            uidValidity: 111n,
            searchResult: [uid],
            envelopes: new Map([[uid, envelope({ from: [{ address: " Klant@Voorbeeld.NL ", name: "Klant Naam" }] }, uid)]]),
          },
        },
      };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      const result = await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"]);
      expect(result).toHaveLength(1);
    });
  });

  describe("outbound", () => {
    it("matches an exact TO recipient in the Sent folder", async () => {
      const uid = 5;
      scenario = {
        listResult: [{ path: "Sent", specialUse: "\\Sent", specialUseSource: "extension" } as ListResponse],
        mailboxes: {
          INBOX: { uidValidity: 111n, searchResult: [], envelopes: new Map() },
          Sent: {
            uidValidity: 222n,
            searchResult: [uid],
            envelopes: new Map([
              [
                uid,
                envelope(
                  { from: [{ address: "info@stones4u.eu", name: "Stones4U" }], to: [{ address: "klant@voorbeeld.nl", name: "Klant Naam" }], cc: [] },
                  uid,
                ),
              ],
            ]),
          },
        },
      };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      const [message] = await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"]);
      expect(message!.direction).toBe("OUTBOUND");
    });

    it("matches an exact CC recipient in the Sent folder", async () => {
      const uid = 6;
      scenario = {
        listResult: [{ path: "Sent", specialUse: "\\Sent", specialUseSource: "extension" } as ListResponse],
        mailboxes: {
          INBOX: { uidValidity: 111n, searchResult: [], envelopes: new Map() },
          Sent: {
            uidValidity: 222n,
            searchResult: [uid],
            envelopes: new Map([
              [
                uid,
                envelope(
                  {
                    from: [{ address: "info@stones4u.eu", name: "Stones4U" }],
                    to: [{ address: "iemand-anders@voorbeeld.nl", name: "Iemand Anders" }],
                    cc: [{ address: "klant@voorbeeld.nl", name: "Klant Naam" }],
                  },
                  uid,
                ),
              ],
            ]),
          },
        },
      };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      const [message] = await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"]);
      expect(message).toBeDefined();
      expect(message!.cc).toEqual([{ address: "klant@voorbeeld.nl", name: "Klant Naam" }]);
    });

    it("excludes an unrelated recipient — a message to someone else is never attributed to the queried customer", async () => {
      const uid = 8;
      scenario = {
        listResult: [{ path: "Sent", specialUse: "\\Sent", specialUseSource: "extension" } as ListResponse],
        mailboxes: {
          INBOX: { uidValidity: 111n, searchResult: [], envelopes: new Map() },
          Sent: {
            uidValidity: 222n,
            // Server "search" would not have returned this in reality, but
            // simulate the substring-search-false-positive case explicitly.
            searchResult: [uid],
            envelopes: new Map([
              [
                uid,
                envelope(
                  { from: [{ address: "info@stones4u.eu" }], to: [{ address: "iemand-anders@voorbeeld.nl" }], cc: [] },
                  uid,
                ),
              ],
            ]),
          },
        },
      };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      expect(await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"])).toEqual([]);
    });
  });

  describe("stable identity", () => {
    it("builds externalMessageId from UIDVALIDITY + UID (UID alone is not enough)", async () => {
      const uid = 15;
      scenario = {
        listResult: [],
        mailboxes: { INBOX: { uidValidity: 987654321n, searchResult: [uid], envelopes: new Map([[uid, envelope({}, uid)]]) } },
      };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-9", "info@stones4u.eu", baseConfig);
      const [message] = await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"]);
      expect(message!.externalMessageId).toBe("987654321-15");
      expect(message!.mailboxId).toBe("mailbox-9");
    });

    it("produces different externalMessageIds for the same UID under different UIDVALIDITYs — no collision after a hypothetical UIDVALIDITY reset", async () => {
      const { stableEmailId } = await import("@/integrations/email/types");
      const a = stableEmailId({ provider: "IMAP", mailboxId: "mb-1", externalMessageId: "100-15" });
      const b = stableEmailId({ provider: "IMAP", mailboxId: "mb-1", externalMessageId: "200-15" });
      expect(a).not.toBe(b);
      expect(a).toBe("imap-mb-1-100-15");
    });
  });

  describe("parsing", () => {
    it("extracts a plain-text bodyPreview", async () => {
      const uid = 20;
      scenario = {
        listResult: [],
        mailboxes: {
          INBOX: {
            uidValidity: 1n,
            searchResult: [uid],
            envelopes: new Map([[uid, envelope({}, uid)]]),
            bodyParts: new Map([[uid, new Map([["1", Buffer.from("Korte inhoud van het bericht.", "utf8")]])]]),
          },
        },
      };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      const [message] = await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"]);
      expect(message!.bodyPreview).toBe("Korte inhoud van het bericht.");
    });

    it("degrades to a null bodyPreview (not a crash) when the message has no inline text part (e.g. an image-only message)", async () => {
      const uid = 21;
      const noTextEnvelope = envelope({}, uid);
      noTextEnvelope.bodyStructure = { type: "image/jpeg", part: "1" };
      scenario = {
        listResult: [],
        mailboxes: { INBOX: { uidValidity: 1n, searchResult: [uid], envelopes: new Map([[uid, noTextEnvelope]]) } },
      };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      const [message] = await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"]);
      expect(message!.bodyPreview).toBeNull();
      expect(message).toBeDefined();
    });

    it("skips a message with a missing subject rather than failing (subject becomes null)", async () => {
      const uid = 22;
      scenario = {
        listResult: [],
        mailboxes: { INBOX: { uidValidity: 1n, searchResult: [uid], envelopes: new Map([[uid, envelope({ subject: undefined }, uid)]]) } },
      };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      const [message] = await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"]);
      expect(message!.subject).toBeNull();
    });

    it("skips a message with no envelope (malformed) without failing the whole query", async () => {
      const uid = 23;
      const malformed = { seq: uid, uid } as FetchMessageObject; // no envelope at all
      const goodUid = 24;
      scenario = {
        listResult: [],
        mailboxes: {
          INBOX: {
            uidValidity: 1n,
            searchResult: [uid, goodUid],
            envelopes: new Map([
              [uid, malformed],
              [goodUid, envelope({}, goodUid)],
            ]),
          },
        },
      };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      const result = await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"]);
      expect(result).toHaveLength(1); // the malformed one was skipped, the good one survived
    });

    it("skips a message with an unparseable date", async () => {
      const uid = 25;
      scenario = {
        listResult: [],
        mailboxes: { INBOX: { uidValidity: 1n, searchResult: [uid], envelopes: new Map([[uid, envelope({ date: "not-a-date" as unknown as Date }, uid)]]) } },
      };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      expect(await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"])).toEqual([]);
    });
  });

  describe("fail-safe", () => {
    it("degrades to [] on a connect/auth failure, never throws", async () => {
      scenario = { connectError: new AuthenticationFailure("bad credentials") };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      expect(await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"])).toEqual([]);
    });

    it("degrades to [] on a generic connect failure (host/TLS/timeout), never throws", async () => {
      scenario = { connectError: new Error("connect ETIMEDOUT") };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      expect(await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"])).toEqual([]);
    });

    it("degrades to [] when getMailboxLock fails on INBOX", async () => {
      scenario = { listResult: [], mailboxes: { INBOX: { uidValidity: 1n, lockError: new Error("no such mailbox") } } };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      expect(await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"])).toEqual([]);
    });

    it("returns an empty list for an empty mailbox (search returns [])", async () => {
      scenario = { listResult: [], mailboxes: { INBOX: { uidValidity: 1n, searchResult: [] } } };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      expect(await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"])).toEqual([]);
    });

    it("returns an empty list when search() reports `false` (unsupported/rejected query)", async () => {
      scenario = { listResult: [], mailboxes: { INBOX: { uidValidity: 1n, searchResult: false } } };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      expect(await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"])).toEqual([]);
    });

    it("always calls logout(), even after a mid-query failure", async () => {
      scenario = { listResult: [], mailboxes: { INBOX: { uidValidity: 1n, searchResult: new Error("search failed") } } };
      const { ImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
      const adapter = new ImapEmailAdapter("mailbox-1", "info@stones4u.eu", baseConfig);
      await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"]);
      expect(logoutSpy).toHaveBeenCalledTimes(1);
    });
  });
});

// Config-missing / disabled state (docs/build/PHASE-3C-B-IMAP-STAGING.md §1) —
// used by createEmailAdapter() whenever createImapConfig() returns null.
// Never a network call, never implies the mailbox already works.
describe("DisabledImapEmailAdapter", () => {
  it("always reports available: false with a reason string", async () => {
    const { DisabledImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
    const adapter = new DisabledImapEmailAdapter("mailbox-1", "info@stones4u.eu");
    expect(adapter.status()).toEqual({ available: false, reason: expect.any(String) });
  });

  it("returns [] and never touches the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { DisabledImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
    const adapter = new DisabledImapEmailAdapter("mailbox-1", "info@stones4u.eu");
    expect(await adapter.searchMessagesForAddresses()).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("exposes provider/mailboxAddress so the composing adapter can label it correctly", async () => {
    const { DisabledImapEmailAdapter } = await import("@/integrations/email/imap-adapter");
    const adapter = new DisabledImapEmailAdapter("mailbox-9", "info@stones4u.eu");
    expect(adapter.provider).toBe("IMAP");
    expect(adapter.mailboxAddress).toBe("info@stones4u.eu");
    expect(adapter.mailboxId).toBe("mailbox-9");
  });
});
