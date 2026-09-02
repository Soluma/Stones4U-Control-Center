import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/platform/auth/guards";
import { prisma } from "@/platform/db/prisma";
import { hashPassword, isPasswordStrongEnough, verifyPassword } from "@/platform/auth/password";
import { destroyAllSessionsForUser, createSession, sessionCookieOptions, SESSION_COOKIE_NAME } from "@/platform/auth/session";
import { toErrorResponse } from "@/lib/api-error";

const bodySchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10) });

export async function POST(request: NextRequest) {
  try {
    const actor = await requireUser();
    const { currentPassword, newPassword } = bodySchema.parse(await request.json());

    if (!isPasswordStrongEnough(newPassword)) {
      return NextResponse.json({ error: "Nieuw wachtwoord moet minimaal 10 tekens zijn." }, { status: 400 });
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: actor.id } });
    const ok = await verifyPassword(user.passwordHash, currentPassword);
    if (!ok) {
      return NextResponse.json({ error: "Huidig wachtwoord is onjuist." }, { status: 400 });
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({ where: { id: actor.id }, data: { passwordHash } });

    // Revoke every other session, keep the current one alive by issuing a
    // fresh one (same pattern as Kassa Systeem's change-password flow).
    await destroyAllSessionsForUser(actor.id);
    const rawToken = await createSession(actor.id, {
      userAgent: request.headers.get("user-agent"),
      ipAddress: request.headers.get("x-forwarded-for"),
    });

    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE_NAME, rawToken, sessionCookieOptions());
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}
