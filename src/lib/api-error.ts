import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { Prisma } from "@/generated/prisma";
import { UnauthenticatedError, ForbiddenError } from "@/platform/auth/guards";
import { OpportunityValidationError } from "@/modules/opportunities/opportunity.service";

/** Central error → HTTP response mapping for API routes, so guard/validation
 * errors never leak a raw stack trace and every route behaves consistently.
 * Also maps the Prisma error codes routes can realistically hit (missing
 * record, unique/FK constraint) to the correct HTTP status instead of a
 * generic 500 — found to be missing for several routes during the Phase 1
 * production readiness review (e.g. PATCH /api/notes/[id] on a deleted or
 * nonexistent note previously surfaced as a bare 500). */
export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "Niet ingelogd." }, { status: 401 });
  }
  if (error instanceof ForbiddenError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: "Ongeldige invoer.", details: error.flatten() }, { status: 400 });
  }
  if (error instanceof OpportunityValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2025") {
      return NextResponse.json({ error: "Niet gevonden." }, { status: 404 });
    }
    if (error.code === "P2002") {
      return NextResponse.json({ error: "Deze waarde bestaat al." }, { status: 409 });
    }
    if (error.code === "P2003") {
      return NextResponse.json({ error: "Ongeldige referentie." }, { status: 400 });
    }
  }
  console.error("api_route_error", error);
  return NextResponse.json({ error: "Er is een onverwachte fout opgetreden." }, { status: 500 });
}
