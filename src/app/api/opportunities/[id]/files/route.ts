import { NextRequest, NextResponse } from "next/server";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { listFilesForOpportunity, uploadFile } from "@/modules/files/file.service";
import { isStorageConfigured } from "@/integrations/storage/r2";
import { FileValidationError } from "@/platform/security/file-validation";
import { toErrorResponse } from "@/lib/api-error";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;
    const files = await listFilesForOpportunity(id);
    return NextResponse.json({ files });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;

    if (!isStorageConfigured()) {
      return NextResponse.json({ error: "Bestandsopslag is nog niet geconfigureerd." }, { status: 503 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Geen bestand ontvangen." }, { status: 400 });
    }
    const title = formData.get("title");
    const description = formData.get("description");

    const buffer = Buffer.from(await file.arrayBuffer());

    const created = await uploadFile(
      {
        filename: file.name,
        declaredMimeType: file.type || "application/octet-stream",
        buffer,
        title: typeof title === "string" && title.length > 0 ? title : undefined,
        description: typeof description === "string" && description.length > 0 ? description : undefined,
        opportunityId: id,
      },
      actor,
    );

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof FileValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return toErrorResponse(error);
  }
}
