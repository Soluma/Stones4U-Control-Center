"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Image as ImageIcon, File as FileIcon, Upload, Trash2, Download } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/Skeleton";
import { Avatar } from "@/components/ui/Avatar";
import { formatDateTime } from "@/lib/format";

type FileRow = {
  id: string;
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  title: string | null;
  description: string | null;
  createdAt: string;
  uploadedBy: { id: string; name: string };
};

function fileIconFor(mimeType: string) {
  if (mimeType.startsWith("image/")) return ImageIcon;
  if (mimeType === "application/pdf") return FileText;
  return FileIcon;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilesPanel({
  customerId,
  opportunityId,
  canEdit,
}: {
  customerId?: string;
  opportunityId?: string;
  canEdit: boolean;
}) {
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Phase 4a — opportunity-scoped when opportunityId is given.
  const basePath = opportunityId ? `/api/opportunities/${opportunityId}` : `/api/customers/${customerId}`;

  const refresh = useCallback(async () => {
    const response = await fetch(`${basePath}/files`);
    const data = await response.json();
    setFiles(data.files ?? []);
  }, [basePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function uploadFiles(fileList: FileList | File[]) {
    setError(null);
    setUploading(true);
    for (const file of Array.from(fileList)) {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch(`${basePath}/files`, { method: "POST", body: formData });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error ?? "Uploaden mislukt.");
      }
    }
    setUploading(false);
    await refresh();
  }

  async function handleOpen(fileId: string) {
    const response = await fetch(`/api/files/${fileId}`);
    if (!response.ok) return;
    const data = await response.json();
    window.open(data.downloadUrl, "_blank", "noopener,noreferrer");
  }

  async function handleDelete(fileId: string) {
    if (!confirm("Dit bestand verwijderen?")) return;
    await fetch(`/api/files/${fileId}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <div className="space-y-4">
      {canEdit && (
        <div
          className={`cc-card flex flex-col items-center justify-center gap-2 border-2 border-dashed p-6 text-center transition ${dragActive ? "border-accent-500 bg-accent-50" : "border-border-subtle"}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            if (e.dataTransfer.files.length > 0) void uploadFiles(e.dataTransfer.files);
          }}
        >
          <Upload className="h-5 w-5 text-ink-tertiary" aria-hidden />
          <p className="text-sm text-ink-secondary">Sleep bestanden hierheen, of</p>
          <Button variant="secondary" size="sm" loading={uploading} onClick={() => inputRef.current?.click()}>
            Bestand kiezen
          </Button>
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) void uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <p className="text-xs text-ink-disabled">Afbeeldingen, PDF, Office-documenten — max 20MB</p>
          {error && <p className="text-xs text-danger-500">{error}</p>}
        </div>
      )}

      {files === null && <SkeletonList rows={2} />}
      {files !== null && files.length === 0 && (
        <EmptyState icon={<FileIcon className="h-5 w-5" />} title="Nog geen bestanden voor deze klant" description="Upload het eerste bestand hierboven." />
      )}

      {files !== null && files.length > 0 && (
        <div className="cc-card divide-y divide-border-subtle">
          {files.map((file) => {
            const Icon = fileIconFor(file.mimeType);
            return (
              <div key={file.id} className="cc-table-row flex items-center justify-between gap-4 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-canvas text-ink-secondary">
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-primary">{file.title || file.originalFilename}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-tertiary">
                      <span>{formatBytes(file.byteSize)}</span>
                      <span>·</span>
                      <span>{file.uploadedBy.name}</span>
                      <span>·</span>
                      <span>{formatDateTime(file.createdAt)}</span>
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Avatar name={file.uploadedBy.name} size="sm" />
                  <IconButton icon={<Download className="h-3.5 w-3.5" />} label="Downloaden/openen" onClick={() => handleOpen(file.id)} />
                  {canEdit && (
                    <IconButton icon={<Trash2 className="h-3.5 w-3.5" />} label="Bestand verwijderen" tone="danger" onClick={() => handleDelete(file.id)} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
