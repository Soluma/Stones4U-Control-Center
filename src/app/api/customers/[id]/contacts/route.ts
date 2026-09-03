import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { createContact, listContactsForCustomer } from "@/modules/crm/customer-contact.service";
import { toErrorResponse } from "@/lib/api-error";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    const includeArchived = request.nextUrl.searchParams.get("archived") === "include";
    const contacts = await listContactsForCustomer(id, { includeArchived });
    return NextResponse.json({ contacts });
  } catch (error) {
    return toErrorResponse(error);
  }
}

const createContactSchema = z.object({
  displayName: z.string().min(1).max(200),
  jobTitle: z.string().max(200).nullable().optional(),
  email: z.string().max(320).nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  isPrimary: z.boolean().optional(),
  isDecisionMaker: z.boolean().optional(),
  isBillingContact: z.boolean().optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = createContactSchema.parse(await request.json());

    const { contact, duplicateWarning } = await createContact({ customerProfileId: id, ...input }, actor);

    return NextResponse.json({ contact, duplicateWarning }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
