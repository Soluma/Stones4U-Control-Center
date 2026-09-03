import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { getOpportunityDetail, updateOpportunity } from "@/modules/opportunities/opportunity.service";
import { toErrorResponse } from "@/lib/api-error";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    const opportunity = await getOpportunityDetail(id);
    return NextResponse.json(opportunity);
  } catch (error) {
    return toErrorResponse(error);
  }
}

const updateOpportunitySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  estimatedValue: z.union([z.string(), z.number()]).nullable().optional(),
  probability: z.number().int().min(0).max(100).nullable().optional(),
  expectedCloseDate: z.string().datetime().nullable().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = updateOpportunitySchema.parse(await request.json());

    const opportunity = await updateOpportunity(
      id,
      {
        title: input.title,
        description: input.description,
        estimatedValue: input.estimatedValue,
        probability: input.probability,
        expectedCloseDate: input.expectedCloseDate === undefined ? undefined : input.expectedCloseDate ? new Date(input.expectedCloseDate) : null,
      },
      actor,
    );

    return NextResponse.json(opportunity);
  } catch (error) {
    return toErrorResponse(error);
  }
}
