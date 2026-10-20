import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const svc = vi.hoisted(() => ({
  requestInvoiceNow: vi.fn(),
  runOnAccountWorker: vi.fn(),
}));
vi.mock("@/modules/on-account/on-account.service", () => svc);
vi.mock("@/modules/on-account/pickup-source", () => ({ offerteAppPickupEvents: vi.fn() }));

import { POST as sendInvoiceNow } from "@/app/api/integrations/on-account/send-invoice-now/route";
import { POST as runWorker } from "@/app/api/internal/on-account/run/route";

const TOKEN = "s".repeat(40);
const WORKER = "w".repeat(40);
const req = (url: string, body: unknown, auth?: string) =>
  new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) } });
const body = { shopifyOrderGid: "gid://shopify/Order/123", requestId: crypto.randomUUID(), requestedBy: { name: "Fons", email: "f@example.com" }, confirmed: true };

describe("on-account routes", () => {
  beforeEach(() => {
    process.env.ON_ACCOUNT_SERVICE_TOKEN = TOKEN;
    process.env.ON_ACCOUNT_WORKER_TOKEN = WORKER;
    process.env.ON_ACCOUNT_SERVICE_ENABLED = "true";
    svc.requestInvoiceNow.mockReset();
    svc.runOnAccountWorker.mockReset();
  });
  afterEach(() => {
    delete process.env.ON_ACCOUNT_SERVICE_TOKEN;
    delete process.env.ON_ACCOUNT_WORKER_TOKEN;
    delete process.env.ON_ACCOUNT_SERVICE_ENABLED;
  });

  it("send-invoice-now: wrong/missing token -> 401, nothing called", async () => {
    for (const auth of [undefined, "Bearer nope", `Basic ${TOKEN}`, `Bearer ${WORKER}`]) {
      const r = await sendInvoiceNow(req("http://x/api/integrations/on-account/send-invoice-now", body, auth));
      expect(r.status).toBe(401);
    }
    expect(svc.requestInvoiceNow).not.toHaveBeenCalled();
  });

  it("send-invoice-now: an unconfigured/short token closes the endpoint", async () => {
    process.env.ON_ACCOUNT_SERVICE_TOKEN = "short";
    expect((await sendInvoiceNow(req("http://x", body, "Bearer short"))).status).toBe(401);
  });

  it("send-invoice-now: service disabled -> 503; confirmed must be true; gid/requestId validated", async () => {
    process.env.ON_ACCOUNT_SERVICE_ENABLED = "false";
    expect((await sendInvoiceNow(req("http://x", body, `Bearer ${TOKEN}`))).status).toBe(503);
    process.env.ON_ACCOUNT_SERVICE_ENABLED = "true";
    for (const bad of [{ ...body, confirmed: false }, { ...body, shopifyOrderGid: "gid://shopify/Customer/1" }, { ...body, requestId: "x" }]) {
      expect((await sendInvoiceNow(req("http://x", bad, `Bearer ${TOKEN}`))).status).toBe(400);
    }
    expect(svc.requestInvoiceNow).not.toHaveBeenCalled();
  });

  it("send-invoice-now: maps outcomes to status codes and returns the state", async () => {
    svc.requestInvoiceNow.mockResolvedValueOnce({
      outcome: "APPLIED",
      row: { state: "INVOICE_SENT", reviewReason: null, dueAt: new Date("2026-11-19T22:59:59Z"), invoiceSentAt: new Date("2026-10-20T10:00:00Z"), invoiceRecipient: "k@example.com", triggerSource: "MANUAL_INVOICE" },
    });
    const ok = await sendInvoiceNow(req("http://x", body, `Bearer ${TOKEN}`));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ state: "INVOICE_SENT", dueAt: "2026-11-19T22:59:59.000Z", invoiceRecipient: "k@example.com" });
    expect(svc.requestInvoiceNow).toHaveBeenCalledWith({ orderGid: body.shopifyOrderGid, requestId: body.requestId, requestedBy: { name: "Fons", email: "f@example.com" }, source: "offerteapp-api" });
    svc.requestInvoiceNow.mockResolvedValueOnce({ outcome: "IGNORED_ALREADY_DELIVERED", row: { state: "INVOICE_SENT" } });
    expect((await sendInvoiceNow(req("http://x", body, `Bearer ${TOKEN}`))).status).toBe(409);
    svc.requestInvoiceNow.mockResolvedValueOnce({ outcome: "NOT_ON_ACCOUNT", row: null });
    expect((await sendInvoiceNow(req("http://x", body, `Bearer ${TOKEN}`))).status).toBe(404);
  });

  it("worker route: only with the worker token, and only when enabled", async () => {
    svc.runOnAccountWorker.mockResolvedValue({ advanced: [], polled: [] });
    expect((await runWorker(req("http://x", {}, `Bearer ${TOKEN}`))).status).toBe(401);
    process.env.ON_ACCOUNT_SERVICE_ENABLED = "false";
    expect((await runWorker(req("http://x", {}, `Bearer ${WORKER}`))).status).toBe(503);
    process.env.ON_ACCOUNT_SERVICE_ENABLED = "true";
    expect((await runWorker(req("http://x", {}, `Bearer ${WORKER}`))).status).toBe(200);
    expect(svc.runOnAccountWorker).toHaveBeenCalledTimes(1);
  });
});
