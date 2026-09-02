import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { getCustomer360, updateCustomerCrmFields } from "@/modules/crm/customer-profile.service";
import { toErrorResponse } from "@/lib/api-error";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    const result = await getCustomer360(id);
    if (!result) {
      return NextResponse.json({ error: "Klant niet gevonden." }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}

const patchSchema = z.object({
  crmStatus: z.enum(["LEAD", "ACTIVE", "INACTIVE", "AT_RISK", "VIP"]).optional(),
  accountManagerId: z.string().nullable().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const changes = patchSchema.parse(await request.json());
    const updated = await updateCustomerCrmFields(id, changes, actor);
    return NextResponse.json(updated);
  } catch (error) {
    return toErrorResponse(error);
  }
}
