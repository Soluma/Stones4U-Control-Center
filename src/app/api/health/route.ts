import { NextResponse } from "next/server";
import { prisma } from "@/platform/db/prisma";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" });
  } catch (error) {
    return NextResponse.json({ status: "error", error: String(error) }, { status: 503 });
  }
}
