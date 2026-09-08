import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteAccess } from "@/platform/auth/guards";
import { createDeliveryDateHandoff } from "@/modules/delivery/delivery-handoff.service";
import { toErrorResponse } from "@/lib/api-error";

// Staff-facing creation — authenticated (ADMIN/AGENT), generates the
// public token. Deliberately not wired into a UI button yet (Phase A scope
// — see docs/QUOTE-DELIVERY-DATE-PORTAL-BUILD.md rollout gates); exists so
// the capability is real, testable, and callable, ready for a future UI to
// call without any service-layer changes.

const createSchema = z.object({
  shopifyDraftOrderGid: z.string().min(1),
  customerProfileId: z.string().min(1).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const actor = await requireWriteAccess();
    const input = createSchema.parse(await request.json());

    const { handoff, rawToken } = await createDeliveryDateHandoff({
      shopifyDraftOrderGid: input.shopifyDraftOrderGid,
      customerProfileId: input.customerProfileId ?? null,
      createdById: actor.id,
    });

    // rawToken is null when a handoff already existed for this Draft Order
    // (idempotent creation) — the raw token is only ever returned once, at
    // the moment it's first generated (never re-derivable from the stored
    // hash), so a repeat call cannot hand it out again.
    return NextResponse.json({
      id: handoff.id,
      status: handoff.status,
      publicUrl: rawToken ? `/delivery/${rawToken}` : null,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
