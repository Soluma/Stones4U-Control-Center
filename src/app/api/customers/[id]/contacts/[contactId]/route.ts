import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAccess } from "@/platform/auth/guards";
import { updateContact } from "@/modules/crm/customer-contact.service";
import { toErrorResponse } from "@/lib/api-error";

const updateContactSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  jobTitle: z.string().max(200).nullable().optional(),
  email: z.string().max(320).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  isPrimary: z.boolean().optional(),
  isDecisionMaker: z.boolean().optional(),
  isBillingContact: z.boolean().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; contactId: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id, contactId } = await params;
    const input = updateContactSchema.parse(await request.json());

    const { contact, duplicateWarning } = await updateContact(id, contactId, input, actor);

    return NextResponse.json({ contact, duplicateWarning });
  } catch (error) {
    return toErrorResponse(error);
  }
}
