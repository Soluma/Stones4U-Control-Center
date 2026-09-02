import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess, ForbiddenError } from "@/platform/auth/guards";
import { prisma } from "@/platform/db/prisma";
import { getMatchesForCustomer, manualLink, confirmMatch } from "@/modules/matching/matching.service";
import { toErrorResponse } from "@/lib/api-error";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    const matches = await getMatchesForCustomer(id);
    return NextResponse.json({ matches });
  } catch (error) {
    return toErrorResponse(error);
  }
}

// Either confirms an existing system-suggested/ambiguous row (matchId), or
// creates a fresh manual link (source + externalRef) — see
// docs/architecture/ADR-007-CUSTOMER-MATCHING-LAYER.md rule 3. No adapter
// produces suggested rows yet in Phase 3a, so in practice only the manual-
// link shape is exercised today; the confirm-existing shape is kept ready
// for Phase 3b/3c rather than added later as a breaking change.
const postSchema = z.union([
  z.object({ matchId: z.string().min(1) }),
  z.object({
    source: z.enum(["TELEFOONSYSTEEM", "GMAIL", "OFFERTEAPP", "S4U_QUOTE_APP"]),
    externalRef: z.string().min(1).max(320),
  }),
]);

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = postSchema.parse(await request.json());

    let match;
    if ("matchId" in input) {
      // Defensive ownership check — this app has no per-customer access
      // boundary (any write-access user can already act on any customer),
      // but confirming a match via a URL for a different customer than the
      // match actually belongs to would be confusing/inconsistent state,
      // not just a permission question — reject it outright.
      const existing = await prisma.externalContactMatch.findUniqueOrThrow({ where: { id: input.matchId } });
      if (existing.customerProfileId !== id) {
        throw new ForbiddenError("Deze match hoort niet bij deze klant.");
      }
      match = await confirmMatch(input.matchId, actor);
    } else {
      match = await manualLink(id, input.source, input.externalRef, actor);
    }

    return NextResponse.json(match, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
