import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { requireUser } from "@/platform/auth/guards";
import { toErrorResponse } from "@/lib/api-error";
import { prisma } from "@/platform/db/prisma";
import { downloadObject } from "@/integrations/storage/r2";

// Op rekening v1, Phase I — download the ONE stored definitive invoice PDF.
// Server-side only (the R2 bucket is private); the checksum is verified on
// every download so a changed object can never be served as the invoice.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    const invoice = await prisma.onAccountInvoice.findUnique({ where: { onAccountOrderId: id } });
    if (!invoice) return NextResponse.json({ error: "Voor deze order is nog geen factuur gemaakt." }, { status: 404 });
    const pdf = await downloadObject(invoice.storageKey);
    if (createHash("sha256").update(pdf).digest("hex") !== invoice.pdfSha256) {
      return NextResponse.json({ error: "De opgeslagen factuur komt niet overeen met de checksum." }, { status: 409 });
    }
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Factuur_${invoice.invoiceNumber.replace(/[^A-Za-z0-9_-]/g, "")}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
