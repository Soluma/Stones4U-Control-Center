import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { createOpportunity, listOpportunitiesForCustomer } from "@/modules/opportunities/opportunity.service";
import { toErrorResponse } from "@/lib/api-error";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    const opportunities = await listOpportunitiesForCustomer(id);
    return NextResponse.json({ opportunities });
  } catch (error) {
    return toErrorResponse(error);
  }
}

const createOpportunitySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  estimatedValue: z.union([z.string(), z.number()]).nullable().optional(),
  probability: z.number().int().min(0).max(100).nullable().optional(),
  expectedCloseDate: z.string().datetime().nullable().optional(),
  ownerUserId: z.string().optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = createOpportunitySchema.parse(await request.json());

    const opportunity = await createOpportunity(
      {
        customerProfileId: id,
        title: input.title,
        description: input.description,
        estimatedValue: input.estimatedValue,
        probability: input.probability,
        expectedCloseDate: input.expectedCloseDate ? new Date(input.expectedCloseDate) : null,
        ownerUserId: input.ownerUserId,
      },
      actor,
    );

    return NextResponse.json(opportunity, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
