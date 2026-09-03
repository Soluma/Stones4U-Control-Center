import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["MICROSOFT_GRAPH_TENANT_ID", "MICROSOFT_GRAPH_CLIENT_ID", "MICROSOFT_GRAPH_CLIENT_SECRET"] as const;

function setEnv() {
  process.env.MICROSOFT_GRAPH_TENANT_ID = "test-tenant";
  process.env.MICROSOFT_GRAPH_CLIENT_ID = "test-client";
  process.env.MICROSOFT_GRAPH_CLIENT_SECRET = "test-secret";
}

// Mocks MSAL entirely — we're testing our own credential/transport wrapper,
// not Microsoft's library. acquireTokenByClientCredential is the one call
// site we depend on.
const acquireTokenByClientCredential = vi.fn();
vi.mock("@azure/msal-node", () => ({
  ConfidentialClientApplication: vi.fn().mockImplementation(() => ({
    acquireTokenByClientCredential: (...args: unknown[]) => acquireTokenByClientCredential(...args),
  })),
}));

describe("createGraphCredential", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("returns null when all env vars are unset", async () => {
    const { createGraphCredential } = await import("@/integrations/email/graph-client");
    expect(createGraphCredential()).toBeNull();
  });

  it("returns null when only some env vars are set", async () => {
    process.env.MICROSOFT_GRAPH_TENANT_ID = "test-tenant";
    const { createGraphCredential } = await import("@/integrations/email/graph-client");
    expect(createGraphCredential()).toBeNull();
  });

  it("returns a credential when all three env vars are set", async () => {
    setEnv();
    const { createGraphCredential } = await import("@/integrations/email/graph-client");
    expect(createGraphCredential()).not.toBeNull();
  });
});

describe("ClientSecretGraphCredential.acquireToken", () => {
  beforeEach(() => {
    vi.resetModules();
    acquireTokenByClientCredential.mockReset();
    setEnv();
  });

  it("requests the Graph .default scope and returns the access token", async () => {
    acquireTokenByClientCredential.mockResolvedValueOnce({ accessToken: "fake-access-token" });
    const { createGraphCredential } = await import("@/integrations/email/graph-client");
    const credential = createGraphCredential()!;

    const token = await credential.acquireToken();

    expect(token).toBe("fake-access-token");
    expect(acquireTokenByClientCredential).toHaveBeenCalledWith({ scopes: ["https://graph.microsoft.com/.default"] });
  });

  it("throws a generic error (never the underlying MSAL detail) when no token comes back", async () => {
    acquireTokenByClientCredential.mockResolvedValueOnce(null);
    const { createGraphCredential } = await import("@/integrations/email/graph-client");
    const credential = createGraphCredential()!;

    await expect(credential.acquireToken()).rejects.toThrow("graph_token_acquisition_failed");
  });
});

describe("graphGet", () => {
  const fakeCredential = { acquireToken: vi.fn().mockResolvedValue("fake-token") };

  beforeEach(() => {
    fakeCredential.acquireToken.mockClear();
    fakeCredential.acquireToken.mockResolvedValue("fake-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON on success and sends the bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ value: [{ id: "1" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { graphGet } = await import("@/integrations/email/graph-client");
    const result = await graphGet<{ value: { id: string }[] }>("/users/x/messages", fakeCredential);

    expect(result).toEqual({ value: [{ id: "1" }] });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer fake-token" });
  });

  it("returns null without retrying on a 401 (bad token / RBAC scope denial)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const { graphGet } = await import("@/integrations/email/graph-client");
    const result = await graphGet("/users/x/messages", fakeCredential);

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null without retrying on a 403", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const { graphGet } = await import("@/integrations/email/graph-client");
    expect(await graphGet("/users/x/messages", fakeCredential)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries once on a 5xx, then gives up", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("server error", { status: 503 }))
      .mockResolvedValueOnce(new Response("server error", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const { graphGet } = await import("@/integrations/email/graph-client");
    expect(await graphGet("/users/x/messages", fakeCredential)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers on the retry after one 5xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("server error", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { graphGet } = await import("@/integrations/email/graph-client");
    expect(await graphGet("/users/x/messages", fakeCredential)).toEqual({ value: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null (never throws) on a timeout, without retrying", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { graphGet } = await import("@/integrations/email/graph-client");
    expect(await graphGet("/users/x/messages", fakeCredential)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null (never throws) when token acquisition itself fails", async () => {
    const failingCredential = { acquireToken: vi.fn().mockRejectedValue(new Error("auth down")) };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { graphGet } = await import("@/integrations/email/graph-client");
    expect(await graphGet("/users/x/messages", failingCredential)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
