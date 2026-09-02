import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, requireWriteAccess } from "@/platform/auth/guards";
import { getFileDownloadUrl, updateFileMetadata, deleteFile } from "@/modules/files/file.service";
import { isStorageConfigured, StorageConfigError } from "@/integrations/storage/r2";
import { toErrorResponse } from "@/lib/api-error";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireUser();
    const { id } = await params;

    if (!isStorageConfigured()) {
      return NextResponse.json({ error: "Bestandsopslag is nog niet geconfigureerd." }, { status: 503 });
    }

    const { url, file } = await getFileDownloadUrl(id);
    return NextResponse.json({
      downloadUrl: url,
      file: { id: file.id, originalFilename: file.originalFilename, mimeType: file.mimeType, byteSize: file.byteSize, title: file.title, description: file.description },
    });
  } catch (error) {
    if (error instanceof StorageConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return toErrorResponse(error);
  }
}

const patchSchema = z.object({ title: z.string().max(200).nullable().optional(), description: z.string().max(2000).nullable().optional() });

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;
    const input = patchSchema.parse(await request.json());
    const file = await updateFileMetadata(id, input, actor);
    return NextResponse.json(file);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireWriteAccess();
    const { id } = await params;

    if (!isStorageConfigured()) {
      return NextResponse.json({ error: "Bestandsopslag is nog niet geconfigureerd." }, { status: 503 });
    }

    await deleteFile(id, actor);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof StorageConfigError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return toErrorResponse(error);
  }
}
