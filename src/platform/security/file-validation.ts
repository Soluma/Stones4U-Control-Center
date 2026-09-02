// File upload validation — allowlist-only (never a denylist), so an unknown
// or unsafe type is rejected by default rather than accidentally permitted.
// SVG is deliberately never in this list (docs/platform-discovery/26 §13 —
// SVG can carry embedded <script>, a real stored-XSS vector if ever served
// inline). No executables, no HTML, no scripts.

export const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB — Phase 2 covers images/PDF/office docs only

type AllowedType = {
  mimeType: string;
  extensions: string[];
  // Magic-byte signature(s) checked against the start of the actual file
  // content — catches a spoofed Content-Type header (docs/platform-discovery/26
  // §13 "spoofed MIME types"). Office/Zip-based formats share one signature
  // (PK\x03\x04) so they can't be told apart by magic bytes alone; the
  // extension + declared type are trusted for that family, magic bytes only
  // confirm "this is genuinely some kind of zip container."
  signatures: number[][];
};

const ALLOWED_TYPES: AllowedType[] = [
  { mimeType: "image/jpeg", extensions: [".jpg", ".jpeg"], signatures: [[0xff, 0xd8, 0xff]] },
  { mimeType: "image/png", extensions: [".png"], signatures: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  { mimeType: "image/gif", extensions: [".gif"], signatures: [[0x47, 0x49, 0x46, 0x38]] },
  { mimeType: "image/webp", extensions: [".webp"], signatures: [[0x52, 0x49, 0x46, 0x46]] },
  { mimeType: "application/pdf", extensions: [".pdf"], signatures: [[0x25, 0x50, 0x44, 0x46]] },
  {
    mimeType: "application/msword",
    extensions: [".doc"],
    signatures: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extensions: [".docx"],
    signatures: [[0x50, 0x4b, 0x03, 0x04]],
  },
  { mimeType: "application/vnd.ms-excel", extensions: [".xls"], signatures: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]] },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extensions: [".xlsx"],
    signatures: [[0x50, 0x4b, 0x03, 0x04]],
  },
  {
    mimeType: "application/vnd.ms-powerpoint",
    extensions: [".ppt"],
    signatures: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  },
  {
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extensions: [".pptx"],
    signatures: [[0x50, 0x4b, 0x03, 0x04]],
  },
  { mimeType: "text/plain", extensions: [".txt"], signatures: [] }, // no reliable magic bytes for plain text — extension + declared type only
  { mimeType: "text/csv", extensions: [".csv"], signatures: [] },
];

const ALLOWED_MIME_TYPES = new Set(ALLOWED_TYPES.map((t) => t.mimeType));

// Types that are safe to render inline in a browser tab (never SVG/HTML) —
// everything else forces a download via Content-Disposition: attachment.
const INLINE_SAFE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"]);

export class FileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileValidationError";
  }
}

function bufferStartsWith(buffer: Buffer, signature: number[]): boolean {
  if (buffer.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

/** Strips path separators/control characters and caps length — the
 * sanitized name is only ever used for display and Content-Disposition,
 * never as the storage key (see r2.ts — storage keys are always random). */
export function sanitizeFilename(name: string): string {
  const base = name.replace(/^.*[/\\]/, "").trim();
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").replace(/["\r\n]/g, "_");
  const truncated = cleaned.slice(0, 200);
  return truncated.length > 0 ? truncated : "bestand";
}

function extensionOf(filename: string): string {
  const match = /\.[a-z0-9]+$/i.exec(filename);
  return match ? match[0].toLowerCase() : "";
}

/** Validates size, declared MIME type (against an allowlist — SVG and
 * anything not explicitly listed is rejected), filename extension
 * consistency, and (where a reliable signature exists) the actual file
 * content's magic bytes — so a renamed/relabeled unsafe file is still
 * caught even if the client lies about its Content-Type. Throws
 * FileValidationError with a clear Dutch message on any failure. */
export function validateUpload(input: { filename: string; declaredMimeType: string; size: number; buffer: Buffer }): {
  mimeType: string;
  sanitizedFilename: string;
  isInlineSafe: boolean;
} {
  if (input.size <= 0) {
    throw new FileValidationError("Bestand is leeg.");
  }
  if (input.size > MAX_FILE_SIZE_BYTES) {
    throw new FileValidationError(`Bestand is te groot (max ${Math.floor(MAX_FILE_SIZE_BYTES / (1024 * 1024))}MB).`);
  }

  const allowed = ALLOWED_TYPES.find((t) => t.mimeType === input.declaredMimeType);
  if (!allowed || !ALLOWED_MIME_TYPES.has(input.declaredMimeType)) {
    throw new FileValidationError("Bestandstype wordt niet ondersteund.");
  }

  const sanitizedFilename = sanitizeFilename(input.filename);
  const ext = extensionOf(sanitizedFilename);
  if (!allowed.extensions.includes(ext)) {
    throw new FileValidationError("Bestandsextensie komt niet overeen met het bestandstype.");
  }

  if (allowed.signatures.length > 0) {
    const matches = allowed.signatures.some((sig) => bufferStartsWith(input.buffer, sig));
    if (!matches) {
      throw new FileValidationError("Bestandsinhoud komt niet overeen met het opgegeven type.");
    }
  }

  return {
    mimeType: input.declaredMimeType,
    sanitizedFilename,
    isInlineSafe: INLINE_SAFE_MIME_TYPES.has(input.declaredMimeType),
  };
}
