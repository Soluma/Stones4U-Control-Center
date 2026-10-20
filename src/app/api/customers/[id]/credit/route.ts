import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, requireUser } from "@/platform/auth/guards";
import { toErrorResponse } from "@/lib/api-error";
import { CustomerCreditError, getCustomerCredit, setCustomerCredit } from "@/modules/on-account/customer-credit.service";

// Op rekening v1 — read (any user) / change (ADMIN only: financial risk) the
// customer's on-account permission and payment term, stored as Shopify
// customer metafields. Every change is audited (customer_credit.updated).

function creditError(error: unknown) {
  if (error instanceof CustomerCreditError) return NextResponse.json({ error: error.message }, { status: error.status });
  return toErrorResponse(error);
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    return NextResponse.json(await getCustomerCredit(id));
  } catch (error) {
    return creditError(error);
  }
}

const putSchema = z.object({
  creditAllowed: z.boolean(),
  termDays: z.number().int().min(1).max(365).nullable(),
});

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireAdmin();
    const { id } = await params;
    const body = putSchema.parse(await request.json());
    return NextResponse.json(await setCustomerCredit(id, body, actor));
  } catch (error) {
    return creditError(error);
  }
}
