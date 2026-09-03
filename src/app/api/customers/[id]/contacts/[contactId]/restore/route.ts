import { NextRequest, NextResponse } from "next/server";
import { requireWriteAccess } from "@/platform/auth/guards";
import { restoreContact } from "@/modules/crm/customer-contact.service";
import { toErrorResponse } from "@/lib/api-error";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string; contactId: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id, contactId } = await params;
    const contact = await restoreContact(id, contactId, actor);
    return NextResponse.json(contact);
  } catch (error) {
    return toErrorResponse(error);
  }
}
