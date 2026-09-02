import "server-only";

// TelefoonSysteem adapter — read-only projection of call activity into the
// Control Center Activity Timeline (docs/architecture/ADR-004, "B.
// External/source activities").
//
// STATUS: ENABLED in Phase 3b. TelefoonSysteem now exposes
// GET /integrations/control-center/calls[?phone=...|/:externalId], guarded
// by its own CRM_SERVICE_TOKEN bearer credential (see that repo's
// apps/api/src/middleware/auth.ts:requireCrmServiceToken) — a dedicated,
// separate credential from its human-JWT `/api` routes and its
// ami-worker-only `x-internal-secret`. Degrades to DisabledTelephonyAdapter
// whenever TELEFOONSYSTEEM_API_BASE_URL/TELEFOONSYSTEEM_SERVICE_TOKEN are
// unset — never a crash, never a half-configured state.
//
// Direction is never guessed: TelefoonSysteem's Call model has no reliable
// inbound/outbound signal (docs/platform-discovery/27-PHASE-3-DISCOVERY.md
// §1.1) — every call this adapter returns reports `direction: "UNKNOWN"`,
// verbatim from the source, never inferred here.

const REQUEST_TIMEOUT_MS = 8_000;

export type TelephonyActivityItem = {
  id: string;
  occurredAt: string;
  title: string;
  summary?: string;
  direction?: "inbound" | "outbound";
  phoneNumber?: string;
};

export type TelephonyAdapterStatus =
  | { available: true }
  | { available: false; reason: string };

export interface TelephonyAdapter {
  status(): TelephonyAdapterStatus;
  /** Read-only. Returns call activity for a customer, matched by phone
   * number(s), for projection into the Activity Timeline. Must return an
   * empty array (never throw) when the adapter is disabled or unreachable —
   * a Customer 360 page must never break because telephony data is
   * unavailable (docs/platform-discovery/25 §8). */
  getActivityForPhoneNumbers(phoneNumbers: string[]): Promise<TelephonyActivityItem[]>;
}

export class DisabledTelephonyAdapter implements TelephonyAdapter {
  constructor(private reason: string = "TelefoonSysteem-integratie is niet geconfigureerd.") {}

  status(): TelephonyAdapterStatus {
    return { available: false, reason: this.reason };
  }

  async getActivityForPhoneNumbers(): Promise<TelephonyActivityItem[]> {
    return [];
  }
}

const DISPOSITION_LABEL: Record<string, string> = {
  RINGING: "Rinkelt",
  ANSWERED: "Beantwoord",
  ENDED: "Beëindigd",
  MISSED: "Gemist",
  ABANDONED: "Opgehangen door beller",
};

type RawCall = {
  externalId: string;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  remoteNumber: string;
  direction: "UNKNOWN" | "INBOUND" | "OUTBOUND";
  disposition: string;
  employee: { id: string; name: string } | null;
};

function formatDuration(seconds: number | null): string | null {
  if (seconds === null || seconds < 0) return null;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

function toActivityItem(call: RawCall): TelephonyActivityItem {
  const label = DISPOSITION_LABEL[call.disposition] ?? call.disposition;
  const duration = formatDuration(call.durationSeconds);
  const summaryParts = [label, duration, call.employee?.name].filter(Boolean);

  return {
    id: call.externalId,
    occurredAt: call.startedAt,
    title: `Telefoongesprek ${call.remoteNumber}`,
    summary: summaryParts.join(" · ") || undefined,
    // `direction` on TelephonyActivityItem is deliberately not set from
    // call.direction — the source only ever reports "UNKNOWN" today (see
    // file header); this field stays reserved for when TelefoonSysteem
    // gains a real direction signal, not populated with a guess now.
    phoneNumber: call.remoteNumber,
  };
}

export class TelefoonSysteemAdapter implements TelephonyAdapter {
  constructor(private baseUrl: string, private serviceToken: string) {}

  status(): TelephonyAdapterStatus {
    return { available: true };
  }

  async getActivityForPhoneNumbers(phoneNumbers: string[]): Promise<TelephonyActivityItem[]> {
    const uniqueNumbers = [...new Set(phoneNumbers.filter(Boolean))];
    if (uniqueNumbers.length === 0) return [];

    const results = await Promise.allSettled(uniqueNumbers.map((phone) => this.fetchCalls(phone)));

    const byId = new Map<string, TelephonyActivityItem>();
    for (const result of results) {
      if (result.status !== "fulfilled") {
        console.error("telefoonsysteem_calls_fetch_failed", result.reason);
        continue;
      }
      for (const item of result.value) byId.set(item.id, item);
    }

    return [...byId.values()].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
  }

  private async fetchCalls(phone: string): Promise<TelephonyActivityItem[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const url = new URL("/integrations/control-center/calls", this.baseUrl);
      url.searchParams.set("phone", phone);

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.serviceToken}` },
        signal: controller.signal,
      });

      if (!response.ok) {
        console.error("telefoonsysteem_calls_http_error", response.status);
        return [];
      }

      const body = (await response.json()) as { calls: RawCall[] };
      return body.calls.map(toActivityItem);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.error("telefoonsysteem_calls_timeout", `${REQUEST_TIMEOUT_MS}ms`);
      } else {
        console.error("telefoonsysteem_calls_request_failed", error instanceof Error ? error.message : error);
      }
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createTelephonyAdapter(): TelephonyAdapter {
  const baseUrl = process.env.TELEFOONSYSTEEM_API_BASE_URL;
  const serviceToken = process.env.TELEFOONSYSTEEM_SERVICE_TOKEN;

  if (!baseUrl || !serviceToken) {
    return new DisabledTelephonyAdapter();
  }

  return new TelefoonSysteemAdapter(baseUrl, serviceToken);
}
