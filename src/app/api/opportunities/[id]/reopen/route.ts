import { NextRequest, NextResponse } from "next/server";
import { requireWriteAccess } from "@/platform/auth/guards";
import { reopen } from "@/modules/opportunities/opportunity.service";
import { toErrorResponse } from "@/lib/api-error";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;

    const opportunity = await reopen(id, actor);
    return NextResponse.json(opportunity);
  } catch (error) {
    return toErrorResponse(error);
  }
}
