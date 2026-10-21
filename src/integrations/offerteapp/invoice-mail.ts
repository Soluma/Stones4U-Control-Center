import "server-only";

// Op rekening v1, Phase I — OfferteApp is Stones4U's existing customer mail
// provider (SMTP configured in its Settings) and the source of the company
// details. Same service token and base URL as the quotes/logistics adapters
// (OFFERTEAPP_API_BASE_URL / OFFERTEAPP_SERVICE_TOKEN). Fails gracefully:
// the caller decides what an unreachable OfferteApp means (ADR-004).

const TIMEOUT_MS = 30_000;
const BASE_PATH = "/api/integrations/control-center";

export type CompanyProfile = {
  name: string | null;
  address: string | null;
  postcode: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  kvk: string | null;
  vatNumber: string | null;
  iban: string | null;
  logo: { mime: string; base64: string } | null;
};

export class OfferteAppUnavailableError extends Error {}

function config(): { baseUrl: string; token: string } {
  const baseUrl = process.env.OFFERTEAPP_API_BASE_URL?.trim();
  const token = process.env.OFFERTEAPP_SERVICE_TOKEN?.trim();
  if (!baseUrl || !token) throw new OfferteAppUnavailableError("OfferteApp-koppeling is niet geconfigureerd.");
  return { baseUrl, token };
}

async function call(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<Response> {
  const { baseUrl, token } = config();
  return fetch(new URL(`${BASE_PATH}${path}`, baseUrl), {
    method: init.method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
}

export async function fetchCompanyProfile(): Promise<CompanyProfile> {
  let response: Response;
  try {
    response = await call("/company-profile", { method: "GET" });
  } catch (error) {
    throw new OfferteAppUnavailableError(`Bedrijfsgegevens niet bereikbaar: ${error instanceof Error ? error.name : "fout"}`);
  }
  if (!response.ok) throw new OfferteAppUnavailableError(`Bedrijfsgegevens: HTTP ${response.status}`);
  return (await response.json()) as CompanyProfile;
}

export type InvoiceMailRequest = {
  sendKey: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachment: { filename: string; contentBase64: string; sha256: string };
};

/**
 * SENT          accepted by SMTP (messageId)
 * NOT_SENT      definitely not accepted; the same sendKey may be retried
 * UNCERTAIN     may have gone out — never retry automatically
 * IN_PROGRESS   another request for this key is still running
 * REJECTED      OfferteApp refused the request itself (4xx) — nothing sent
 * UNKNOWN       no answer (timeout/network/5xx) — ask status() before anything else
 */
export type InvoiceMailOutcome =
  | { status: "SENT"; messageId: string | null }
  | { status: "NOT_SENT" | "UNCERTAIN" | "IN_PROGRESS" | "REJECTED" | "UNKNOWN"; detail: string | null };

function fromBody(body: { status?: string; messageId?: string; detail?: string; error?: string }): InvoiceMailOutcome {
  switch (body.status) {
    case "SENT":
      return { status: "SENT", messageId: body.messageId ?? null };
    case "NOT_SENT":
    case "UNCERTAIN":
    case "IN_PROGRESS":
      return { status: body.status, detail: body.detail ?? null };
    default:
      return { status: "UNKNOWN", detail: `onverwacht antwoord ${String(body.status ?? body.error ?? "")}`.slice(0, 120) };
  }
}

export async function sendInvoiceMail(request: InvoiceMailRequest): Promise<InvoiceMailOutcome> {
  let response: Response;
  try {
    response = await call("/invoice-mail", { method: "POST", body: request });
  } catch (error) {
    return { status: "UNKNOWN", detail: `geen antwoord van OfferteApp (${error instanceof Error ? error.name : "fout"})` };
  }
  if (response.status >= 500) return { status: "UNKNOWN", detail: `OfferteApp HTTP ${response.status}` };
  const body = (await response.json().catch(() => ({}))) as { status?: string; messageId?: string; detail?: string; error?: string };
  if (!response.ok) return { status: "REJECTED", detail: `HTTP ${response.status}: ${String(body.error ?? "").slice(0, 120)}` };
  return fromBody(body);
}

export type InvoiceMailStatus =
  | { status: "SENT"; messageId: string | null }
  | { status: "NONE" | "NOT_SENT" | "UNCERTAIN" | "IN_PROGRESS" | "UNKNOWN"; detail: string | null };

/** What OfferteApp knows about this send key — the reliable way to resolve an unknown outcome. */
export async function invoiceMailStatus(sendKey: string): Promise<InvoiceMailStatus> {
  let response: Response;
  try {
    response = await call(`/invoice-mail/${encodeURIComponent(sendKey)}`, { method: "GET" });
  } catch (error) {
    return { status: "UNKNOWN", detail: `status niet bereikbaar (${error instanceof Error ? error.name : "fout"})` };
  }
  if (!response.ok) return { status: "UNKNOWN", detail: `status HTTP ${response.status}` };
  const body = (await response.json().catch(() => ({}))) as { status?: string; messageId?: string; detail?: string };
  if (body.status === "NONE") return { status: "NONE", detail: null };
  const outcome = fromBody(body);
  if (outcome.status === "SENT") return outcome;
  return { status: outcome.status === "REJECTED" ? "UNKNOWN" : outcome.status, detail: outcome.detail };
}
