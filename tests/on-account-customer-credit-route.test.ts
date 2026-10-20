import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const g = vi.hoisted(() => ({ role: "AGENT" as "ADMIN" | "AGENT" | "VIEWER", set: vi.fn() }));
vi.mock("@/platform/auth/session", () => ({ getSessionUser: vi.fn(async () => ({ id: "u1", email: "u@example.com", name: "U", role: g.role })) }));
vi.mock("@/modules/on-account/customer-credit.service", () => ({
  CustomerCreditError: class extends Error {},
  getCustomerCredit: vi.fn(async () => ({ creditAllowed: false })),
  setCustomerCredit: g.set,
}));

import { GET, PUT } from "@/app/api/customers/[id]/credit/route";

const put = () => new NextRequest("http://x", { method: "PUT", body: JSON.stringify({ creditAllowed: true, termDays: 30 }), headers: { "content-type": "application/json" } });
const params = { params: Promise.resolve({ id: "p1" }) };

describe("customer credit route", () => {
  it("only an ADMIN may change it; AGENT and VIEWER get 403 and nothing is written", async () => {
    for (const role of ["AGENT", "VIEWER"] as const) {
      g.role = role;
      expect((await PUT(put(), params)).status).toBe(403);
    }
    expect(g.set).not.toHaveBeenCalled();
    g.role = "ADMIN";
    g.set.mockResolvedValueOnce({ creditAllowed: true, effectiveTermDays: 30 });
    expect((await PUT(put(), params)).status).toBe(200);
    expect(g.set).toHaveBeenCalledTimes(1);
  });
  it("every logged-in role may read it", async () => {
    g.role = "VIEWER";
    expect((await GET(new NextRequest("http://x"), params)).status).toBe(200);
  });
});
