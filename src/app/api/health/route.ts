import { NextResponse } from "next/server";
import { prisma } from "@/platform/db/prisma";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" });
  } catch (error) {
    // Never echo the raw error to the response — a Prisma initialization
    // error can include the datasource connection string. Full detail goes
    // to the server log only (fly logs), never to this public, pre-auth
    // endpoint.
    console.error("health_check_db_error", error);
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
