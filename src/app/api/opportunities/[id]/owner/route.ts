import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAccess } from "@/platform/auth/guards";
import { assignOwner } from "@/modules/opportunities/opportunity.service";
import { toErrorResponse } from "@/lib/api-error";

const ownerSchema = z.object({ ownerUserId: z.string().min(1) });

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = ownerSchema.parse(await request.json());

    const opportunity = await assignOwner(id, input.ownerUserId, actor);
    return NextResponse.json(opportunity);
  } catch (error) {
    return toErrorResponse(error);
  }
}
