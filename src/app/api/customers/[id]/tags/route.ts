import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAccess } from "@/platform/auth/guards";
import { assignTagToCustomer, unassignTagFromCustomer } from "@/modules/crm/customer-tag.service";
import { toErrorResponse } from "@/lib/api-error";

const tagSchema = z.object({ tagId: z.string().min(1) });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = tagSchema.parse(await request.json());
    const assignment = await assignTagToCustomer(id, input.tagId, actor);
    return NextResponse.json(assignment, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = tagSchema.parse(await request.json());
    await unassignTagFromCustomer(id, input.tagId, actor);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
