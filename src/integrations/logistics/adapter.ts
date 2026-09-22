import "server-only";

import {
  logisticsBatchSchema,
  logisticsDetailResponseSchema,
  type OrderLogisticsDetail,
  type OrderLogisticsSummary,
} from "./types";

/**
 * Logistics adapter (OfferteApp) — read-only projection of picking, pallets,
 * scans, photos and transport into Customer 360.
 *
 * Same shape and credential as the quotes adapter next door: the
 * OfferteApp service token stays on the server, a slow sibling is cut off by
 * a timeout, and an unreachable sibling degrades to a visible "temporarily
 * unavailable" — never a thrown error, never an empty result pretending the
 * order was never picked (docs/platform-discovery/25 §8).
 *
 * The CRM stores none of this and derives none of it: handoffType,
 * scheduleState, the Van Eijk pickup day and the Dutch status label all come
 * from OfferteApp (its docs/CRM-LOGISTICS-API.md, contract commit 9eb16c5).
 */

const REQUEST_TIMEOUT_MS = 8_000;
/** The contract allows 50 ids; 25 keeps the URL comfortably short. */
const CHUNK_SIZE = 25;

export type LogisticsAdapterStatus = { available: true } | { available: false; reason: string };

export type LogisticsBatchResult =
  | {
      ok: true;
      byOrderId: Map<string, OrderLogisticsSummary>;
      /** Ids Shopify does not know — genuinely absent, not a failure. */
      notFound: string[];
      /** True when at least one chunk failed: show what we have, say the rest is missing. */
      partial: boolean;
    }
  | { ok: false; reason: "unavailable" | "failed" };

export type LogisticsDetailResult =
  | { ok: true; order: OrderLogisticsDetail }
  | { ok: false; reason: "unavailable" | "failed" | "not_found" };

export interface LogisticsAdapter {
  status(): LogisticsAdapterStatus;
  /** One call per chunk of order ids — never one call per order. */
  getForOrders(shopifyOrderIds: string[]): Promise<LogisticsBatchResult>;
  getForOrder(shopifyOrderId: string): Promise<LogisticsDetailResult>;
}

class DisabledLogisticsAdapter implements LogisticsAdapter {
  constructor(private readonly reason: string) {}

  status(): LogisticsAdapterStatus {
    return { available: false, reason: this.reason };
  }

  async getForOrders(): Promise<LogisticsBatchResult> {
    return { ok: false, reason: "unavailable" };
  }

  async getForOrder(): Promise<LogisticsDetailResult> {
    return { ok: false, reason: "unavailable" };
  }
}

type FetchOutcome<T> = { ok: true; body: T } | { ok: false; reason: "failed" | "not_found" };

class OfferteAppLogisticsAdapter implements LogisticsAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
  ) {}

  status(): LogisticsAdapterStatus {
    return { available: true };
  }

  private async fetchJson(url: URL): Promise<FetchOutcome<unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.serviceToken}` },
        signal: controller.signal,
        cache: "no-store",
      });
      if (response.status === 404) return { ok: false, reason: "not_found" };
      if (!response.ok) {
        // The token itself is never logged, here or anywhere else.
        console.error("logistics_adapter_http_error", url.hostname, response.status);
        return { ok: false, reason: "failed" };
      }
      return { ok: true, body: await response.json() };
    } catch (error) {
      const label = error instanceof Error && error.name === "AbortError" ? "timeout" : "request_failed";
      console.error("logistics_adapter_" + label, url.hostname, error instanceof Error ? error.message : error);
      return { ok: false, reason: "failed" };
    } finally {
      clearTimeout(timeout);
    }
  }

  async getForOrders(shopifyOrderIds: string[]): Promise<LogisticsBatchResult> {
    const ids = [...new Set(shopifyOrderIds.map((id) => id.trim()).filter((id) => /^\d+$/.test(id)))];
    if (ids.length === 0) return { ok: true, byOrderId: new Map(), notFound: [], partial: false };

    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) chunks.push(ids.slice(i, i + CHUNK_SIZE));

    const results = await Promise.all(
      chunks.map(async (chunk) => {
        const url = new URL("/api/integrations/control-center/logistics", this.baseUrl);
        url.searchParams.set("shopify_order_ids", chunk.join(","));
        const outcome = await this.fetchJson(url);
        if (!outcome.ok) return null;
        const parsed = logisticsBatchSchema.safeParse(outcome.body);
        if (!parsed.success) {
          console.error("logistics_adapter_invalid_batch", url.hostname, parsed.error.issues.slice(0, 3));
          return null;
        }
        return parsed.data;
      }),
    );

    if (results.every((result) => result === null)) return { ok: false, reason: "failed" };

    const byOrderId = new Map<string, OrderLogisticsSummary>();
    const notFound: string[] = [];
    for (const result of results) {
      if (!result) continue;
      for (const order of result.orders) byOrderId.set(order.shopifyOrderId, order);
      notFound.push(...result.notFound);
    }
    return { ok: true, byOrderId, notFound, partial: results.some((result) => result === null) };
  }

  async getForOrder(shopifyOrderId: string): Promise<LogisticsDetailResult> {
    const id = shopifyOrderId.trim();
    if (!/^\d+$/.test(id)) return { ok: false, reason: "not_found" };
    const url = new URL(`/api/integrations/control-center/logistics/${id}`, this.baseUrl);
    const outcome = await this.fetchJson(url);
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    const parsed = logisticsDetailResponseSchema.safeParse(outcome.body);
    if (!parsed.success) {
      console.error("logistics_adapter_invalid_detail", url.hostname, parsed.error.issues.slice(0, 3));
      return { ok: false, reason: "failed" };
    }
    return { ok: true, order: parsed.data.order };
  }
}

/** Same credential as the quotes adapter: one OfferteApp, one CRM token. */
export function createLogisticsAdapter(): LogisticsAdapter {
  const baseUrl = process.env.OFFERTEAPP_API_BASE_URL;
  const serviceToken = process.env.OFFERTEAPP_SERVICE_TOKEN;
  if (!baseUrl || !serviceToken) {
    return new DisabledLogisticsAdapter("OfferteApp is niet gekoppeld (OFFERTEAPP_API_BASE_URL/OFFERTEAPP_SERVICE_TOKEN).");
  }
  return new OfferteAppLogisticsAdapter(baseUrl, serviceToken);
}

/** `gid://shopify/Order/123` → `123`; OfferteApp keys on the legacy id. */
export function legacyOrderId(gid: string): string | null {
  const match = /\/(\d+)$/.exec(gid);
  return match?.[1] ?? null;
}
