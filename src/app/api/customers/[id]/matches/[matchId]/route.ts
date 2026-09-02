import { NextRequest, NextResponse } from "next/server";
import { requireWriteAccess, ForbiddenError } from "@/platform/auth/guards";
import { prisma } from "@/platform/db/prisma";
import { unlinkMatch } from "@/modules/matching/matching.service";
import { toErrorResponse } from "@/lib/api-error";

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string; matchId: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id, matchId } = await params;

    const existing = await prisma.externalContactMatch.findUniqueOrThrow({ where: { id: matchId } });
    if (existing.customerProfileId !== id) {
      throw new ForbiddenError("Deze match hoort niet bij deze klant.");
    }

    await unlinkMatch(matchId, actor);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
