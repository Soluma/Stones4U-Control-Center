import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { listCustomerTags, createCustomerTag } from "@/modules/crm/customer-tag.service";
import { toErrorResponse } from "@/lib/api-error";

export async function GET() {
  try {
    await requireUser();
    const tags = await listCustomerTags();
    return NextResponse.json({ tags });
  } catch (error) {
    return toErrorResponse(error);
  }
}

const createSchema = z.object({
  name: z.string().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const actor = await requireWriteAccess();
    const input = createSchema.parse(await request.json());
    const tag = await createCustomerTag(input, actor);
    return NextResponse.json(tag, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
