import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAccess } from "@/platform/auth/guards";
import { markWon } from "@/modules/opportunities/opportunity.service";
import { toErrorResponse } from "@/lib/api-error";

const wonSchema = z.object({ finalValue: z.union([z.string(), z.number()]).nullable().optional() });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = wonSchema.parse(await request.json().catch(() => ({})));

    const opportunity = await markWon(id, { finalValue: input.finalValue }, actor);
    return NextResponse.json(opportunity);
  } catch (error) {
    return toErrorResponse(error);
  }
}
