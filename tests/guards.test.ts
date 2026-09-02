import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/platform/db/prisma";
import { createTestUser, cleanupUser } from "./fixtures";

// Regression test for a real bug found during the Phase 1 production
// readiness review: PATCH /api/tasks/[id] originally gated on requireUser()
// only, delegating authorization entirely to task.service's
// creator/assignee/admin check — which does NOT consider role. A VIEWER
// assigned a task by someone else could therefore mutate it via a direct
// API call, despite VIEWER being defined as read-only everywhere else. The
// fix is requireWriteAccess() at the route layer (see
// src/app/api/tasks/[id]/route.ts); this test covers the guard itself, the
// mechanism every write route depends on, so the same bug class can't
// silently reappear in a different route.

let currentRawToken: string | null = null;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "cc_session" && currentRawToken ? { value: currentRawToken } : undefined),
  }),
}));

describe("requireWriteAccess", () => {
  let viewerId: string;
  let agentId: string;

  beforeAll(async () => {
    const viewer = await createTestUser({ role: "VIEWER" });
    const agent = await createTestUser({ role: "AGENT" });
    viewerId = viewer.id;
    agentId = agent.id;
  });

  afterAll(async () => {
    await cleanupUser(viewerId);
    await cleanupUser(agentId);
    await prisma.$disconnect();
  });

  it("rejects a VIEWER with ForbiddenError, even for an authenticated, valid session", async () => {
    const { createSession } = await import("@/platform/auth/session");
    const { requireWriteAccess } = await import("@/platform/auth/guards");
    const { ForbiddenError } = await import("@/platform/auth/guards");

    currentRawToken = await createSession(viewerId, {});
    await expect(requireWriteAccess()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("allows an AGENT", async () => {
    const { createSession } = await import("@/platform/auth/session");
    const { requireWriteAccess } = await import("@/platform/auth/guards");

    currentRawToken = await createSession(agentId, {});
    const user = await requireWriteAccess();
    expect(user.id).toBe(agentId);
  });

  it("rejects when there is no session at all", async () => {
    const { requireWriteAccess, UnauthenticatedError } = await import("@/platform/auth/guards");
    currentRawToken = null;
    await expect(requireWriteAccess()).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});
