import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["TELEFOONSYSTEEM_API_BASE_URL", "TELEFOONSYSTEEM_SERVICE_TOKEN"] as const;

function setEnv() {
  process.env.TELEFOONSYSTEEM_API_BASE_URL = "https://telefoon-api.fly.dev";
  process.env.TELEFOONSYSTEEM_SERVICE_TOKEN = "test-service-token";
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("createTelephonyAdapter", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is disabled (available: false) when env vars are unset — never a crash", async () => {
    const { createTelephonyAdapter } = await import("@/integrations/telephony/adapter");
    const adapter = createTelephonyAdapter();
    expect(adapter.status()).toEqual({ available: false, reason: expect.any(String) });
    expect(await adapter.getActivityForPhoneNumbers(["31612345678"])).toEqual([]);
  });

  it("is disabled when only one of the two env vars is set", async () => {
    process.env.TELEFOONSYSTEEM_API_BASE_URL = "https://telefoon-api.fly.dev";
    const { createTelephonyAdapter } = await import("@/integrations/telephony/adapter");
    expect(createTelephonyAdapter().status().available).toBe(false);
  });

  it("parses calls, reports direction as UNKNOWN (never a guess), and builds a stable synthetic id", async () => {
    setEnv();
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        calls: [
          {
            externalId: "call_abc123",
            startedAt: "2026-09-03T10:00:00Z",
            answeredAt: "2026-09-03T10:00:05Z",
            endedAt: "2026-09-03T10:03:00Z",
            durationSeconds: 175,
            remoteNumber: "0612345678",
            direction: "UNKNOWN",
            disposition: "ENDED",
            employee: { id: "user_1", name: "Jan de Vries" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createTelephonyAdapter } = await import("@/integrations/telephony/adapter");
    const items = await createTelephonyAdapter().getActivityForPhoneNumbers(["31612345678"]);

    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe("call_abc123");
    expect(items[0]!.direction).toBeUndefined(); // never populated from a guess
    expect(items[0]!.summary).toContain("Beëindigd");
    expect(items[0]!.summary).toContain("Jan de Vries");

    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toContain("/integrations/control-center/calls?phone=31612345678");
    expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-service-token" });
  });

  it("returns [] (never throws) when TelefoonSysteem is unreachable", async () => {
    setEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("connect ECONNREFUSED")),
    );
    const { createTelephonyAdapter } = await import("@/integrations/telephony/adapter");
    expect(await createTelephonyAdapter().getActivityForPhoneNumbers(["31612345678"])).toEqual([]);
  });

  it("returns [] (never throws) when TelefoonSysteem returns a non-2xx status", async () => {
    setEnv();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("unauthorized", { status: 401 })));
    const { createTelephonyAdapter } = await import("@/integrations/telephony/adapter");
    expect(await createTelephonyAdapter().getActivityForPhoneNumbers(["31612345678"])).toEqual([]);
  });

  it("degrades to an empty list, never throws, when the request times out (AbortError)", async () => {
    setEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementationOnce(() => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      }),
    );
    const { createTelephonyAdapter } = await import("@/integrations/telephony/adapter");
    const result = await createTelephonyAdapter().getActivityForPhoneNumbers(["31612345678"]);
    expect(result).toEqual([]);
  });

  it("queries multiple candidate phone numbers and dedupes by call id", async () => {
    setEnv();
    const call = {
      externalId: "call_shared",
      startedAt: "2026-09-03T10:00:00Z",
      answeredAt: null,
      endedAt: null,
      durationSeconds: null,
      remoteNumber: "0612345678",
      direction: "UNKNOWN",
      disposition: "RINGING",
      employee: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ calls: [call] }))
      .mockResolvedValueOnce(jsonResponse({ calls: [call] }));
    vi.stubGlobal("fetch", fetchMock);

    const { createTelephonyAdapter } = await import("@/integrations/telephony/adapter");
    const items = await createTelephonyAdapter().getActivityForPhoneNumbers(["31612345678", "0612345678"]);
    expect(items).toHaveLength(1);
  });
});
