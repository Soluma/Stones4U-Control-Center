import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/platform/auth/guards";
import { deleteCustomerTag } from "@/modules/crm/customer-tag.service";
import { toErrorResponse } from "@/lib/api-error";

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireAdmin();
    const { id } = await params;
    await deleteCustomerTag(id, actor);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
