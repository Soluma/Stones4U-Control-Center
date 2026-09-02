import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/platform/auth/guards";
import { createUser, listUsers } from "@/modules/admin/user.service";
import { toErrorResponse } from "@/lib/api-error";

export async function GET() {
  try {
    await requireAdmin();
    const users = await listUsers();
    return NextResponse.json({ users });
  } catch (error) {
    return toErrorResponse(error);
  }
}

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
  password: z.string().min(10),
  role: z.enum(["ADMIN", "AGENT", "VIEWER"]),
});

export async function POST(request: NextRequest) {
  try {
    const actor = await requireAdmin();
    const input = createUserSchema.parse(await request.json());
    const user = await createUser(input, actor);
    return NextResponse.json({ id: user.id, email: user.email, name: user.name, role: user.role }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
