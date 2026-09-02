import { NextResponse } from "next/server";
import { requireUser } from "@/platform/auth/guards";
import { prisma } from "@/platform/db/prisma";
import { toErrorResponse } from "@/lib/api-error";

// Lightweight, non-admin-gated list of active users for task-assignee
// pickers — deliberately returns far less than /api/admin/users (no email,
// no lastLoginAt) since any AGENT/VIEWER can call this, not just ADMIN.
export async function GET() {
  try {
    await requireUser();
    const users = await prisma.user.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    return NextResponse.json({ users });
  } catch (error) {
    return toErrorResponse(error);
  }
}
