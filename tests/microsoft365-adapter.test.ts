import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const stubCredential = { acquireToken: vi.fn().mockResolvedValue("fake-token") };

function graphMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    conversationId: "conv-1",
    subject: "Vraag over levering",
    from: { emailAddress: { address: "klant@voorbeeld.nl", name: "Klant Naam" } },
    toRecipients: [{ emailAddress: { address: "info@stones4u.nl", name: "Stones4U" } }],
    ccRecipients: [],
    sentDateTime: "2026-09-01T09:00:00Z",
    receivedDateTime: "2026-09-01T09:00:05Z",
    bodyPreview: "Korte samenvatting van het bericht...",
    webLink: "https://outlook.office.com/mail/id/abc",
    ...overrides,
  };
}

describe("Microsoft365EmailAdapter", () => {
  beforeEach(() => {
    stubCredential.acquireToken.mockClear();
    stubCredential.acquireToken.mockResolvedValue("fake-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports available: true once constructed", async () => {
    const { Microsoft365EmailAdapter } = await import("@/integrations/email/microsoft365-adapter");
    const adapter = new Microsoft365EmailAdapter("mailbox-1", "info@stones4u.nl", stubCredential);
    expect(adapter.status()).toEqual({ available: true });
  });

  it("returns [] without calling fetch for an empty address list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { Microsoft365EmailAdapter } = await import("@/integrations/email/microsoft365-adapter");
    const adapter = new Microsoft365EmailAdapter("mailbox-1", "info@stones4u.nl", stubCredential);
    expect(await adapter.searchMessagesForAddresses([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks a message as INBOUND when `from` differs from the mailbox's own address", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ value: [graphMessage()] })));
    const { Microsoft365EmailAdapter } = await import("@/integrations/email/microsoft365-adapter");
    const adapter = new Microsoft365EmailAdapter("mailbox-1", "info@stones4u.nl", stubCredential);

    const [message] = await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"]);

    expect(message!.direction).toBe("INBOUND");
    expect(message!.from).toEqual({ address: "klant@voorbeeld.nl", name: "Klant Naam" });
    expect(message!.occurredAt.toISOString()).toBe("2026-09-01T09:00:05.000Z"); // receivedDateTime for inbound
  });

  it("marks a message as OUTBOUND when `from` equals the mailbox's own address (case/whitespace-insensitive)", async () => {
    const message = graphMessage({
      from: { emailAddress: { address: " Info@Stones4U.nl ", name: "Stones4U" } },
      toRecipients: [{ emailAddress: { address: "klant@voorbeeld.nl", name: "Klant Naam" } }],
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ value: [message] })));
    const { Microsoft365EmailAdapter } = await import("@/integrations/email/microsoft365-adapter");
    const adapter = new Microsoft365EmailAdapter("mailbox-1", "info@stones4u.nl", stubCredential);

    const [result] = await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"]);

    expect(result!.direction).toBe("OUTBOUND");
    expect(result!.occurredAt.toISOString()).toBe("2026-09-01T09:00:00.000Z"); // sentDateTime for outbound
  });

  it("parses cc and multiple recipients", async () => {
    const message = graphMessage({
      toRecipients: [
        { emailAddress: { address: "klant-a@voorbeeld.nl", name: "Klant A" } },
        { emailAddress: { address: "klant-b@voorbeeld.nl", name: "Klant B" } },
      ],
      ccRecipients: [{ emailAddress: { address: "collega@stones4u.nl", name: "Collega" } }],
      from: { emailAddress: { address: "info@stones4u.nl", name: "Stones4U" } },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ value: [message] })));
    const { Microsoft365EmailAdapter } = await import("@/integrations/email/microsoft365-adapter");
    const adapter = new Microsoft365EmailAdapter("mailbox-1", "info@stones4u.nl", stubCredential);

    const [result] = await adapter.searchMessagesForAddresses(["klant-a@voorbeeld.nl"]);

    expect(result!.to).toHaveLength(2);
    expect(result!.cc).toEqual([{ address: "collega@stones4u.nl", name: "Collega" }]);
  });

  it("defaults missing bodyPreview, conversationId, and webLink to null", async () => {
    const message = graphMessage({ bodyPreview: undefined, conversationId: undefined, webLink: undefined });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ value: [message] })));
    const { Microsoft365EmailAdapter } = await import("@/integrations/email/microsoft365-adapter");
    const adapter = new Microsoft365EmailAdapter("mailbox-1", "info@stones4u.nl", stubCredential);

    const [result] = await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"]);

    expect(result!.bodyPreview).toBeNull();
    expect(result!.conversationId).toBeNull();
    expect(result!.webLink).toBeNull();
  });

  it("skips a message with no resolvable `from` address rather than guessing a direction", async () => {
    const message = graphMessage({ from: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ value: [message] })));
    const { Microsoft365EmailAdapter } = await import("@/integrations/email/microsoft365-adapter");
    const adapter = new Microsoft365EmailAdapter("mailbox-1", "info@stones4u.nl", stubCredential);

    expect(await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"])).toEqual([]);
  });

  it("skips a message with an unparseable date", async () => {
    const message = graphMessage({ sentDateTime: "not-a-date", receivedDateTime: "also-not-a-date" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ value: [message] })));
    const { Microsoft365EmailAdapter } = await import("@/integrations/email/microsoft365-adapter");
    const adapter = new Microsoft365EmailAdapter("mailbox-1", "info@stones4u.nl", stubCredential);

    expect(await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"])).toEqual([]);
  });

  it("dedupes by externalMessageId across multiple queried addresses", async () => {
    const message = graphMessage();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: [message] }))
      .mockResolvedValueOnce(jsonResponse({ value: [message] }));
    vi.stubGlobal("fetch", fetchMock);
    const { Microsoft365EmailAdapter } = await import("@/integrations/email/microsoft365-adapter");
    const adapter = new Microsoft365EmailAdapter("mailbox-1", "info@stones4u.nl", stubCredential);

    const result = await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl", "ander@voorbeeld.nl"]);
    expect(result).toHaveLength(1);
  });

  it("degrades to [] (never throws) when the Graph request fails outright", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("connect ECONNREFUSED")));
    const { Microsoft365EmailAdapter } = await import("@/integrations/email/microsoft365-adapter");
    const adapter = new Microsoft365EmailAdapter("mailbox-1", "info@stones4u.nl", stubCredential);

    expect(await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"])).toEqual([]);
  });

  it("never issues a query for an address containing a double quote (KQL-injection guard)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { Microsoft365EmailAdapter } = await import("@/integrations/email/microsoft365-adapter");
    const adapter = new Microsoft365EmailAdapter("mailbox-1", "info@stones4u.nl", stubCredential);

    // normalizeEmail's shape check does not exclude `"`, so this reaches
    // the adapter — buildSearchQuery() must reject it, not interpolate it.
    const result = await adapter.searchMessagesForAddresses(['odd"address@voorbeeld.nl']);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests ImmutableId and eventual consistency, and sets an explicit $top cap", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ value: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { Microsoft365EmailAdapter } = await import("@/integrations/email/microsoft365-adapter");
    const adapter = new Microsoft365EmailAdapter("mailbox-1", "info@stones4u.nl", stubCredential);

    await adapter.searchMessagesForAddresses(["klant@voorbeeld.nl"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("$top=25");
    expect(String(url)).toContain("/users/info%40stones4u.nl/messages");
    expect((init as RequestInit).headers).toMatchObject({ ConsistencyLevel: "eventual", Prefer: 'IdType="ImmutableId"' });
  });
});
