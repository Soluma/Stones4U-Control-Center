import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { createOpportunity, listOpportunities, type OpportunityListFilter } from "@/modules/opportunities/opportunity.service";
import { toErrorResponse } from "@/lib/api-error";

const STAGES = ["NEW", "CONTACTED", "NEEDS_DEFINED", "QUOTE_PREPARATION", "QUOTE_SENT", "NEGOTIATION"] as const;
const STATUSES = ["OPEN", "WON", "LOST", "ALL"] as const;
const ARCHIVED = ["exclude", "only", "all"] as const;

export async function GET(request: NextRequest) {
  try {
    await requireUser();
    const params = request.nextUrl.searchParams;

    const status = params.get("status");
    const stage = params.get("stage");
    const archived = params.get("archived");

    const filter: OpportunityListFilter = {
      status: status && (STATUSES as readonly string[]).includes(status) ? (status as OpportunityListFilter["status"]) : undefined,
      stage: stage && (STAGES as readonly string[]).includes(stage) ? (stage as OpportunityListFilter["stage"]) : undefined,
      ownerUserId: params.get("ownerUserId") ?? undefined,
      customerProfileId: params.get("customerProfileId") ?? undefined,
      search: params.get("search") ?? undefined,
      archived: archived && (ARCHIVED as readonly string[]).includes(archived) ? (archived as OpportunityListFilter["archived"]) : undefined,
    };

    const opportunities = await listOpportunities(filter);
    return NextResponse.json({ opportunities });
  } catch (error) {
    return toErrorResponse(error);
  }
}

const createOpportunitySchema = z.object({
  customerProfileId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  estimatedValue: z.union([z.string(), z.number()]).nullable().optional(),
  probability: z.number().int().min(0).max(100).nullable().optional(),
  expectedCloseDate: z.string().datetime().nullable().optional(),
  ownerUserId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const actor = await requireWriteAccess();
    const input = createOpportunitySchema.parse(await request.json());

    const opportunity = await createOpportunity(
      {
        customerProfileId: input.customerProfileId,
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
