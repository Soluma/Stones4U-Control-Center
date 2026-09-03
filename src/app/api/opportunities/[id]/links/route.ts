import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAccess } from "@/platform/auth/guards";
import { addExternalLink } from "@/modules/opportunities/opportunity.service";
import { toErrorResponse } from "@/lib/api-error";

const linkSchema = z.object({
  linkType: z.enum(["OFFERTEAPP_QUOTE", "S4U_QUOTE_APP_QUOTE", "SHOPIFY_DRAFT_ORDER", "SHOPIFY_ORDER"]),
  externalRef: z.string().min(1).max(200),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = linkSchema.parse(await request.json());

    const link = await addExternalLink(id, input, actor);
    return NextResponse.json(link, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
