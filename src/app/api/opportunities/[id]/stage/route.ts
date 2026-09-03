import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAccess } from "@/platform/auth/guards";
import { changeStage } from "@/modules/opportunities/opportunity.service";
import { toErrorResponse } from "@/lib/api-error";

const stageSchema = z.object({
  stage: z.enum(["NEW", "CONTACTED", "NEEDS_DEFINED", "QUOTE_PREPARATION", "QUOTE_SENT", "NEGOTIATION"]),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = stageSchema.parse(await request.json());

    const opportunity = await changeStage(id, input.stage, actor);
    return NextResponse.json(opportunity);
  } catch (error) {
    return toErrorResponse(error);
  }
}
