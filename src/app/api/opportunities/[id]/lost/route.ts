import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAccess } from "@/platform/auth/guards";
import { markLost } from "@/modules/opportunities/opportunity.service";
import { toErrorResponse } from "@/lib/api-error";

const lostSchema = z.object({ lostReason: z.string().min(1).max(500) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = lostSchema.parse(await request.json());

    const opportunity = await markLost(id, { lostReason: input.lostReason }, actor);
    return NextResponse.json(opportunity);
  } catch (error) {
    return toErrorResponse(error);
  }
}
