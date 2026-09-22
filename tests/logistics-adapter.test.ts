import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogisticsAdapter, legacyOrderId } from "@/integrations/logistics/adapter";

// The logistics adapter is the CRM's only door to OfferteApp's warehouse
// data. These tests hold it to the two promises the rest of the feature
// depends on: it never throws (a sibling being down is a degraded section,
// not a broken page), and it never invents data (a failure is reported as a
// failure, never as an order with nothing picked).

const BASE_URL = "https://offerteapp.example";
const TOKEN = "test-service-token";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    shopifyOrderId: "13242694992204",
    shopifyOrderGid: "gid://shopify/Order/13242694992204",
    orderName: "#1474",
    orderCreatedAt: "2026-09-21T15:12:03Z",
    operationalStatus: { value: "Klaar voor ophalen transporteur", label: "Klaar ophalen van Eijk" },
    handoffType: "VAN_EIJK",
    scheduleState: "FIXED_DATE",
    requestedDate: "2026-09-24",
    deliveryNote: null,
    pick: {
      started: true,
      completed: true,
      pickedLines: 4,
      totalLines: 4,
      deviationCount: 0,
      startedAt: "2026-09-22T07:10:00Z",
      startedByName: "Fons",
      completedAt: "2026-09-22T08:00:00Z",
      completedByName: "Fons",
    },
    lock: { active: false, claimedByName: null, claimedAt: null, lastActivityAt: null, expires: false },
    pallets: { total: 5, scanned: 0 },
    photos: { count: 0, pendingCount: 0, failedCount: 0 },
    transport: null,
    lastEvent: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.OFFERTEAPP_API_BASE_URL = BASE_URL;
  process.env.OFFERTEAPP_SERVICE_TOKEN = TOKEN;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.OFFERTEAPP_API_BASE_URL;
  delete process.env.OFFERTEAPP_SERVICE_TOKEN;
});

describe("logistics adapter — configuration", () => {
  it("is unavailable without credentials and still answers both calls safely", async () => {
    delete process.env.OFFERTEAPP_API_BASE_URL;
    delete process.env.OFFERTEAPP_SERVICE_TOKEN;
    const adapter = createLogisticsAdapter();

    const status = adapter.status();
    expect(status.available).toBe(false);
    await expect(adapter.getForOrders(["1"])).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(adapter.getForOrder("1")).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the service token as a bearer header, server-side only", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ orders: [summary()], notFound: [] }));
    await createLogisticsAdapter().getForOrders(["13242694992204"]);

    const init = fetchMock.mock.calls[0]![1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.cache).toBe("no-store");
  });
});

describe("logistics adapter — batch", () => {
  it("returns the summaries keyed by Shopify order id, plus notFound", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ orders: [summary()], notFound: ["999"] }));

    const result = await createLogisticsAdapter().getForOrders(["13242694992204", "999"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.byOrderId.get("13242694992204")?.orderName).toBe("#1474");
    expect(result.notFound).toEqual(["999"]);
    expect(result.partial).toBe(false);
  });

  it("asks once per chunk of 25 ids — never once per order", async () => {
    const ids = Array.from({ length: 60 }, (_, index) => String(1_000_000 + index));
    fetchMock.mockResolvedValue(jsonResponse({ orders: [], notFound: [] }));

    await createLogisticsAdapter().getForOrders(ids);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requested = fetchMock.mock.calls.flatMap((call) =>
      (call[0] as URL).searchParams.get("shopify_order_ids")!.split(","),
    );
    expect(requested).toHaveLength(60);
    expect(new Set(requested).size).toBe(60);
  });

  it("drops duplicate and non-numeric ids before asking, and asks nothing when none remain", async () => {
    const adapter = createLogisticsAdapter();

    await adapter.getForOrders(["42", "42", "gid://shopify/Order/42"]);
    expect((fetchMock.mock.calls[0]![0] as URL).searchParams.get("shopify_order_ids")).toBe("42");

    fetchMock.mockClear();
    const empty = await adapter.getForOrders(["", "not-a-number"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(empty).toEqual({ ok: true, byOrderId: new Map(), notFound: [], partial: false });
  });

  it("reports a partial batch when one chunk fails, keeping the chunk that succeeded", async () => {
    const ids = Array.from({ length: 30 }, (_, index) => String(2_000_000 + index));
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ orders: [summary()], notFound: [] }))
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));

    const result = await createLogisticsAdapter().getForOrders(ids);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.partial).toBe(true);
    expect(result.byOrderId.size).toBe(1);
  });

  it("fails as a failure when every chunk fails — never as an empty result", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "boom" }, 502));
    await expect(createLogisticsAdapter().getForOrders(["1"])).resolves.toEqual({ ok: false, reason: "failed" });
  });

  it("treats a malformed batch response as a failure, not as empty data", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ orders: [{ shopifyOrderId: 42 }] }));
    await expect(createLogisticsAdapter().getForOrders(["42"])).resolves.toEqual({ ok: false, reason: "failed" });
  });

  it("survives a network error and a timeout without throwing", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(createLogisticsAdapter().getForOrders(["1"])).resolves.toEqual({ ok: false, reason: "failed" });

    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abortError);
    await expect(createLogisticsAdapter().getForOrders(["1"])).resolves.toEqual({ ok: false, reason: "failed" });
  });

  it("aborts a request that outlives the timeout instead of hanging the page", async () => {
    fetchMock.mockImplementation(
      (_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );

    vi.useFakeTimers();
    try {
      const pending = createLogisticsAdapter().getForOrders(["1"]);
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(pending).resolves.toEqual({ ok: false, reason: "failed" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("logistics adapter — detail", () => {
  const detail = {
    ...summary(),
    lines: [
      {
        lineItemId: "55",
        lineItemGid: "gid://shopify/LineItem/55",
        orderedQuantity: 2,
        pickedQuantity: 2,
        picked: true,
        resolved: true,
        deviation: null,
        deviationNote: null,
        pickedByName: "Fons",
        pickedAt: "2026-09-22T07:30:00Z",
        updatedAt: "2026-09-22T07:30:00Z",
      },
    ],
    palletDetails: [],
    timeline: [],
  };

  it("returns the parsed order", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ order: detail }));

    const result = await createLogisticsAdapter().getForOrder("13242694992204");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.lines[0]?.lineItemId).toBe("55");
    expect((fetchMock.mock.calls[0]![0] as URL).pathname).toBe(
      "/api/integrations/control-center/logistics/13242694992204",
    );
  });

  it("defaults the detail-only collections when the sibling omits them", async () => {
    const withoutCollections: Record<string, unknown> = { ...detail };
    delete withoutCollections.lines;
    delete withoutCollections.palletDetails;
    delete withoutCollections.timeline;
    fetchMock.mockResolvedValue(jsonResponse({ order: withoutCollections }));

    const result = await createLogisticsAdapter().getForOrder("13242694992204");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.lines).toEqual([]);
    expect(result.order.palletDetails).toEqual([]);
    expect(result.order.timeline).toEqual([]);
  });

  it("reports an unknown order as not_found, distinct from a failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    await expect(createLogisticsAdapter().getForOrder("404404")).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("never asks for a non-numeric id", async () => {
    await expect(createLogisticsAdapter().getForOrder("gid://shopify/Order/1")).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a malformed detail response as a failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ order: { shopifyOrderId: "1" } }));
    await expect(createLogisticsAdapter().getForOrder("1")).resolves.toEqual({ ok: false, reason: "failed" });
  });

  it("keeps an unknown enum value safe instead of rejecting the whole order", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ order: { ...detail, handoffType: "SOMETHING_NEW", scheduleState: "SOMETHING_NEW" } }),
    );

    const result = await createLogisticsAdapter().getForOrder("13242694992204");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.handoffType).toBe("UNKNOWN");
    expect(result.order.scheduleState).toBe("NOT_SET");
  });

  it("never logs the service token", async () => {
    const errorSpy = vi.spyOn(console, "error");
    fetchMock.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    await createLogisticsAdapter().getForOrder("1");

    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain(TOKEN);
  });
});

describe("legacyOrderId", () => {
  it("takes the numeric tail of a Shopify order GID", () => {
    expect(legacyOrderId("gid://shopify/Order/13242694992204")).toBe("13242694992204");
    expect(legacyOrderId("not-a-gid")).toBeNull();
  });
});
