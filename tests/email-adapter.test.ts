import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db/prisma";
import type { FetchMessageObject } from "imapflow";

// Minimal fake IMAP client — just enough to prove the Microsoft365-disabled
// + IMAP-available aggregation scenario (§10) end-to-end against the real
// database and real matching service, without a network connection.
class FakeImapFlow {
  mailbox: { uidValidity: bigint } | false = false;
  private currentPath: string | null = null;
  constructor(public options: unknown) {}
  async connect() {}
  async logout() {}
  async list() {
    return [];
  }
  async getMailboxLock(path: string) {
    this.currentPath = path;
    this.mailbox = { uidValidity: 555n };
    return { path, release: vi.fn() };
  }
  async search() {
    return this.currentPath === "INBOX" ? [1] : [];
  }
  async *fetch(): AsyncGenerator<FetchMessageObject> {
    if (this.currentPath !== "INBOX") return;
    yield {
      seq: 1,
      uid: 1,
      envelope: {
        date: new Date("2026-09-01T09:00:00Z"),
        subject: "Vraag via Xel",
        from: [{ address: "imap-klant@voorbeeld.nl", name: "IMAP Klant" }],
        to: [{ address: "info@stones4u.eu", name: "Stones4U" }],
        cc: [],
      },
      bodyStructure: { type: "text/plain", part: "1", parameters: { charset: "utf-8" } },
    } as FetchMessageObject;
  }
  async fetchOne() {
    return false as const;
  }
}
vi.mock("imapflow", () => ({ ImapFlow: FakeImapFlow, AuthenticationFailure: class extends Error {} }));

function setGraphEnv() {
  process.env.MICROSOFT_GRAPH_TENANT_ID = "test-tenant";
  process.env.MICROSOFT_GRAPH_CLIENT_ID = "test-client";
  process.env.MICROSOFT_GRAPH_CLIENT_SECRET = "test-secret";
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Stubs only the credential factory (as a vi.fn(), so individual tests can
// override its return value with mockReturnValueOnce) — graphGet/
// Microsoft365EmailAdapter run for real against a mocked global fetch, so
// this is a genuine integration test of the composing adapter -> per-mailbox
// adapter -> matching-service -> real database pipeline, without ever
// calling Microsoft.
const createGraphCredentialMock = vi.fn((): { acquireToken: () => Promise<string> } | null => ({ acquireToken: async () => "fake-token" }));
vi.mock("@/integrations/email/graph-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/integrations/email/graph-client")>();
  return { ...actual, createGraphCredential: () => createGraphCredentialMock() };
});

describe("createEmailAdapter — composing adapter, real DB", () => {
  const mailboxIds: string[] = [];
  const profileIds: string[] = [];

  beforeAll(async () => {
    setGraphEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    for (const id of mailboxIds) await prisma.monitoredMailbox.delete({ where: { id } }).catch(() => undefined);
    for (const id of profileIds) {
      await prisma.externalContactMatch.deleteMany({ where: { customerProfileId: id } });
      await prisma.customerProfile.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  it("is disabled (available: false) when there are no MonitoredMailbox rows", async () => {
    vi.resetModules();
    const { createEmailAdapter } = await import("@/integrations/email/adapter");
    const adapter = await createEmailAdapter();
    expect(adapter.status()).toEqual({ available: false, reason: expect.any(String) });
    expect(await adapter.getMessagesForAddresses(["x@voorbeeld.nl"])).toEqual([]);
  });

  it("reports a MICROSOFT365 mailbox as unavailable when the Graph credential is missing, without crashing", async () => {
    vi.resetModules();
    createGraphCredentialMock.mockReturnValueOnce(null); // simulates createGraphCredential() finding no/incomplete env vars

    const row = await prisma.monitoredMailbox.create({
      data: { emailAddress: `no-creds-${crypto.randomUUID()}@stones4u.test`, provider: "MICROSOFT365", enabled: true },
    });
    mailboxIds.push(row.id);

    const { createEmailAdapter } = await import("@/integrations/email/adapter");
    const adapter = await createEmailAdapter();
    expect(adapter.status()).toEqual({ available: false, reason: expect.stringContaining("MICROSOFT_GRAPH") });
    expect(await adapter.getMessagesForAddresses(["x@voorbeeld.nl"])).toEqual([]);

    // Cleaned up immediately (not just in afterAll) — later tests in this
    // file call the real findMany() and must not see this row.
    await prisma.monitoredMailbox.delete({ where: { id: row.id } });
    mailboxIds.splice(mailboxIds.indexOf(row.id), 1);
  });

  it(
    "end-to-end: fetches real Graph-shaped messages, records EMAIL matches (exact inbound, ambiguous outbound, no match), " +
      "and keeps working when a second mailbox fails outright",
    async () => {
      vi.resetModules();
      setGraphEnv();

      const customerA = await prisma.customerProfile.create({
        data: { shopifyCustomerGid: `gid://shopify/Customer/${crypto.randomUUID()}`, displayName: "Klant A", email: "matcha@voorbeeld.nl" },
      });
      const customerB1 = await prisma.customerProfile.create({
        data: { shopifyCustomerGid: `gid://shopify/Customer/${crypto.randomUUID()}`, displayName: "Klant B1", email: "shared@voorbeeld.nl" },
      });
      const customerB2 = await prisma.customerProfile.create({
        data: { shopifyCustomerGid: `gid://shopify/Customer/${crypto.randomUUID()}`, displayName: "Klant B2", email: "shared@voorbeeld.nl" },
      });
      profileIds.push(customerA.id, customerB1.id, customerB2.id);

      const workingMailbox = await prisma.monitoredMailbox.create({
        data: { emailAddress: `working-${crypto.randomUUID()}@stones4u.test`, provider: "MICROSOFT365", enabled: true },
      });
      const brokenMailbox = await prisma.monitoredMailbox.create({
        data: { emailAddress: `broken-${crypto.randomUUID()}@stones4u.test`, provider: "MICROSOFT365", enabled: true },
      });
      mailboxIds.push(workingMailbox.id, brokenMailbox.id);

      const canned = {
        value: [
          {
            id: "msg-inbound-exact",
            conversationId: "conv-1",
            subject: "Vraag over bestelling",
            from: { emailAddress: { address: "matcha@voorbeeld.nl", name: "Klant A" } },
            toRecipients: [{ emailAddress: { address: workingMailbox.emailAddress, name: "Stones4U" } }],
            ccRecipients: [],
            receivedDateTime: "2026-09-01T09:00:00Z",
            bodyPreview: "preview",
            webLink: "https://outlook.office.com/mail/id/1",
          },
          {
            id: "msg-outbound-ambiguous",
            conversationId: "conv-2",
            subject: "Antwoord op uw vraag",
            from: { emailAddress: { address: workingMailbox.emailAddress, name: "Stones4U" } },
            toRecipients: [{ emailAddress: { address: "shared@voorbeeld.nl", name: "Gedeeld adres" } }],
            ccRecipients: [],
            sentDateTime: "2026-09-02T10:00:00Z",
            bodyPreview: "preview",
            webLink: "https://outlook.office.com/mail/id/2",
          },
          {
            id: "msg-inbound-no-match",
            conversationId: "conv-3",
            subject: "Onbekende afzender",
            from: { emailAddress: { address: "onbekend@nergens.example", name: "Onbekend" } },
            toRecipients: [{ emailAddress: { address: workingMailbox.emailAddress, name: "Stones4U" } }],
            ccRecipients: [],
            receivedDateTime: "2026-09-03T11:00:00Z",
            bodyPreview: "preview",
            webLink: null,
          },
        ],
      };

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes(encodeURIComponent(brokenMailbox.emailAddress))) {
          return Promise.reject(new Error("connect ECONNREFUSED"));
        }
        return Promise.resolve(jsonResponse(canned));
      });
      vi.stubGlobal("fetch", fetchMock);

      const { createEmailAdapter } = await import("@/integrations/email/adapter");
      const adapter = await createEmailAdapter();
      expect(adapter.status()).toEqual({ available: true });

      const messages = await adapter.getMessagesForAddresses(["matcha@voorbeeld.nl"]);

      // The broken mailbox failed outright — the working mailbox's 3
      // messages still come through, newest first.
      expect(messages).toHaveLength(3);
      expect(messages.map((m) => m.externalMessageId)).toEqual(["msg-inbound-no-match", "msg-outbound-ambiguous", "msg-inbound-exact"]);
      expect(new Set(messages.map((m) => m.externalMessageId)).size).toBe(messages.length); // no duplicates
      expect(messages.every((m) => m.mailboxId === workingMailbox.id)).toBe(true);

      // Exact inbound: customerA is the sole candidate for its own address.
      const matchesA = await prisma.externalContactMatch.findMany({ where: { customerProfileId: customerA.id, source: "EMAIL" } });
      expect(matchesA).toHaveLength(1);
      expect(matchesA[0]?.confidence).toBe("EXACT");
      // externalRef is the contact identity (normalized email address),
      // never the message id — ADR-007 correction, docs/build/PHASE-3C-B-EMAIL-MATCH-FIX.md.
      expect(matchesA[0]?.externalRef).toBe("matcha@voorbeeld.nl");

      // Ambiguous outbound: the same address belongs to two CustomerProfiles
      // — both recorded as AMBIGUOUS, neither auto-confirmed.
      const matchesB1 = await prisma.externalContactMatch.findMany({ where: { customerProfileId: customerB1.id, source: "EMAIL" } });
      const matchesB2 = await prisma.externalContactMatch.findMany({ where: { customerProfileId: customerB2.id, source: "EMAIL" } });
      expect(matchesB1).toHaveLength(1);
      expect(matchesB2).toHaveLength(1);
      expect(matchesB1[0]?.confidence).toBe("AMBIGUOUS");
      expect(matchesB2[0]?.confidence).toBe("AMBIGUOUS");
      expect(matchesB1[0]?.confirmedByUserId).toBeNull();
      expect(matchesB2[0]?.confirmedByUserId).toBeNull();

      // No match: the unknown sender has no CustomerProfile — nothing recorded.
      const strayMatches = await prisma.externalContactMatch.findMany({ where: { externalRef: { contains: "msg-inbound-no-match" } } });
      expect(strayMatches).toHaveLength(0);

      // Cleaned up immediately (not just in afterAll) — a later test in
      // this file computes overall EmailAdapter status from *every*
      // MonitoredMailbox row, and a leftover MICROSOFT365 row here (with a
      // still-valid mocked Graph credential) would silently make that test
      // pass for the wrong reason.
      await prisma.monitoredMailbox.deleteMany({ where: { id: { in: [workingMailbox.id, brokenMailbox.id] } } });
      for (const id of [workingMailbox.id, brokenMailbox.id]) mailboxIds.splice(mailboxIds.indexOf(id), 1);
    },
  );

  it("Microsoft 365 unavailable (unconfigured) + IMAP available -> EmailAdapter still returns the IMAP results (§10)", async () => {
    vi.resetModules();
    createGraphCredentialMock.mockReturnValueOnce(null); // Microsoft 365 stays parked/unconfigured

    process.env.IMAP_HOST = "mail.xel.nl";
    process.env.IMAP_PORT = "993";
    process.env.IMAP_USERNAME = "info@stones4u.eu";
    process.env.IMAP_PASSWORD = "test-password";

    const customer = await prisma.customerProfile.create({
      data: { shopifyCustomerGid: `gid://shopify/Customer/${crypto.randomUUID()}`, displayName: "IMAP Klant", email: "imap-klant@voorbeeld.nl" },
    });
    profileIds.push(customer.id);

    const graphRow = await prisma.monitoredMailbox.create({
      data: { emailAddress: `unconfigured-${crypto.randomUUID()}@stones4u.test`, provider: "MICROSOFT365", enabled: true },
    });
    const imapRow = await prisma.monitoredMailbox.create({
      data: { emailAddress: `imap-test-1-${crypto.randomUUID()}@stones4u.test`, provider: "IMAP", enabled: true },
    });
    mailboxIds.push(graphRow.id, imapRow.id);

    const { createEmailAdapter } = await import("@/integrations/email/adapter");
    const adapter = await createEmailAdapter();

    // Overall status is available — one working provider is enough, even
    // though the Microsoft 365 row is unavailable.
    expect(adapter.status()).toEqual({ available: true });

    const messages = await adapter.getMessagesForAddresses(["imap-klant@voorbeeld.nl"]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.provider).toBe("IMAP");
    expect(messages[0]!.mailboxId).toBe(imapRow.id);
    expect(messages[0]!.externalMessageId).toBe("555-1");

    const matches = await prisma.externalContactMatch.findMany({ where: { customerProfileId: customer.id, source: "EMAIL" } });
    expect(matches).toHaveLength(1);
    // externalRef is the contact identity (normalized email address),
    // never the message id (which would have been "imap-{mailboxId}-555-1").
    expect(matches[0]?.externalRef).toBe("imap-klant@voorbeeld.nl");

    await prisma.monitoredMailbox.deleteMany({ where: { id: { in: [graphRow.id, imapRow.id] } } });
    for (const id of [graphRow.id, imapRow.id]) mailboxIds.splice(mailboxIds.indexOf(id), 1);

    for (const key of ["IMAP_HOST", "IMAP_PORT", "IMAP_USERNAME", "IMAP_PASSWORD"]) delete process.env[key];
  });

  it("IMAP unavailable (unconfigured) -> degrades gracefully without a crash", async () => {
    vi.resetModules();
    setGraphEnv();
    for (const key of ["IMAP_HOST", "IMAP_PORT", "IMAP_USERNAME", "IMAP_PASSWORD"]) delete process.env[key];

    const imapRow = await prisma.monitoredMailbox.create({
      data: { emailAddress: `imap-test-2-${crypto.randomUUID()}@stones4u.test`, provider: "IMAP", enabled: true },
    });
    mailboxIds.push(imapRow.id);

    const { createEmailAdapter } = await import("@/integrations/email/adapter");
    const adapter = await createEmailAdapter();
    expect(adapter.status()).toEqual({ available: false, reason: expect.stringContaining("IMAP") });
    expect(await adapter.getMessagesForAddresses(["x@voorbeeld.nl"])).toEqual([]);
  });
});
