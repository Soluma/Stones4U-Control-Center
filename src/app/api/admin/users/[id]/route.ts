import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/platform/auth/guards";
import { changeUserRole, deactivateUser } from "@/modules/admin/user.service";
import { toErrorResponse } from "@/lib/api-error";

const patchSchema = z.union([
  z.object({ role: z.enum(["ADMIN", "AGENT", "VIEWER"]) }),
  z.object({ active: z.literal(false) }),
]);

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireAdmin();
    const { id } = await params;
    const input = patchSchema.parse(await request.json());

    const user = "role" in input ? await changeUserRole(id, input.role, actor) : await deactivateUser(id, actor);

    return NextResponse.json({ id: user.id, role: user.role, active: user.active });
  } catch (error) {
    return toErrorResponse(error);
  }
}
