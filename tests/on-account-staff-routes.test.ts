import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const g = vi.hoisted(() => ({ role: "VIEWER" as "ADMIN" | "AGENT" | "VIEWER", delivered: vi.fn(), resolve: vi.fn(), reconcile: vi.fn() }));
vi.mock("@/platform/auth/session", () => ({ getSessionUser: vi.fn(async () => ({ id: "u1", email: "u@example.com", name: "U", role: g.role })) }));
vi.mock("@/modules/on-account/on-account.service", () => ({
  OnAccountActionError: class extends Error {},
  recordManualDelivery: g.delivered,
  resolveReview: g.resolve,
  reconcileOnAccountOrder: g.reconcile,
}));

import { POST as delivered } from "@/app/api/on-account/[id]/delivered/route";
import { POST as review } from "@/app/api/on-account/[id]/review/route";

const params = { params: Promise.resolve({ id: "r1" }) };
const req = (body: unknown) => new NextRequest("http://x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("on-account staff routes", () => {
  beforeEach(() => {
    process.env.ON_ACCOUNT_SERVICE_ENABLED = "true";
    g.delivered.mockReset().mockResolvedValue({ outcome: "APPLIED", id: "r1", state: "INVOICE_SENT" });
    g.resolve.mockReset().mockResolvedValue({ state: "WAITING_FOR_DELIVERY" });
  });
  afterEach(() => delete process.env.ON_ACCOUNT_SERVICE_ENABLED);

  it("Afgeleverd bij klant: VIEWER 403; confirmation required; AGENT allowed", async () => {
    const ok = { deliveredAt: new Date().toISOString(), confirmed: true };
    g.role = "VIEWER";
    expect((await delivered(req(ok), params)).status).toBe(403);
    g.role = "AGENT";
    expect((await delivered(req({ ...ok, confirmed: false }), params)).status).toBe(400);
    expect(g.delivered).not.toHaveBeenCalled();
    expect((await delivered(req(ok), params)).status).toBe(200);
    expect(g.delivered).toHaveBeenCalledWith("r1", expect.any(Date), "u1");
  });

  it("review decisions are ADMIN-only and need a note", async () => {
    g.role = "AGENT";
    expect((await review(req({ resolution: "RETRY_INVOICE", note: "gecontroleerd" }), params)).status).toBe(403);
    g.role = "ADMIN";
    expect((await review(req({ resolution: "RETRY_INVOICE", note: "" }), params)).status).toBe(400);
    expect(g.resolve).not.toHaveBeenCalled();
    expect((await review(req({ resolution: "RETRY_INVOICE", note: "niet verstuurd volgens Shopify" }), params)).status).toBe(200);
  });

  it("everything is closed while the service is disabled", async () => {
    process.env.ON_ACCOUNT_SERVICE_ENABLED = "false";
    g.role = "ADMIN";
    expect((await delivered(req({ deliveredAt: new Date().toISOString(), confirmed: true }), params)).status).toBe(503);
    expect(g.delivered).not.toHaveBeenCalled();
  });
});
