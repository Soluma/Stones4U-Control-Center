import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { getCustomer360, updateCustomerCrmFields, resetCompanyNameToShopify, assignCustomerToSelfIfUnassigned } from "@/modules/crm/customer-profile.service";
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
  // Phase 5a — docs/architecture/ADR-011-CUSTOMER-IDENTITY-TYPE.md
  customerTypeOverride: z.enum(["INDIVIDUAL", "ORGANIZATION"]).nullable().optional(),
  companyName: z.string().nullable().optional(),
  // Atomic "reset to Shopify" action (build spec §9) — when true, all other
  // fields in the same request are ignored and companyName is reset from a
  // fresh Shopify read instead.
  resetCompanyNameToShopify: z.literal(true).optional(),
  // Phase 6b — "Aan mij toewijzen" quick action (build spec §1.5). When
  // true, all other fields in the same request are ignored — accountManagerId
  // is always resolved server-side to the actor from requireWriteAccess(),
  // and the write is a concurrency-safe conditional update (only succeeds
  // if the customer is still unassigned at write time — see
  // assignCustomerToSelfIfUnassigned(), final review §10). A client-supplied
  // accountManagerId is never read for this action.
  assignToSelf: z.literal(true).optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const body = patchSchema.parse(await request.json());

    if (body.resetCompanyNameToShopify) {
      const updated = await resetCompanyNameToShopify(id, actor);
      return NextResponse.json(updated);
    }

    if (body.assignToSelf) {
      const updated = await assignCustomerToSelfIfUnassigned(id, actor);
      if (!updated) {
        return NextResponse.json({ error: "Deze klant is inmiddels al aan een andere accountmanager toegewezen." }, { status: 409 });
      }
      return NextResponse.json(updated);
    }

    const updated = await updateCustomerCrmFields(
      id,
      {
        crmStatus: body.crmStatus,
        accountManagerId: body.accountManagerId,
        customerTypeOverride: body.customerTypeOverride,
        companyName: body.companyName,
      },
      actor,
    );
    return NextResponse.json(updated);
  } catch (error) {
    return toErrorResponse(error);
  }
}
