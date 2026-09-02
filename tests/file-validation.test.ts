import { describe, expect, it } from "vitest";
import { validateUpload, sanitizeFilename, FileValidationError, MAX_FILE_SIZE_BYTES } from "@/platform/security/file-validation";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const PDF_SIGNATURE = Buffer.from("%PDF-1.4 rest of file");
const FAKE_HTML = Buffer.from("<html><script>alert(1)</script></html>");

describe("file-validation", () => {
  it("accepts a genuine PNG with matching filename/mimetype/magic bytes", () => {
    const result = validateUpload({ filename: "foto.png", declaredMimeType: "image/png", size: PNG_SIGNATURE.byteLength, buffer: PNG_SIGNATURE });
    expect(result.mimeType).toBe("image/png");
    expect(result.isInlineSafe).toBe(true);
  });

  it("accepts a genuine PDF and marks it inline-safe", () => {
    const result = validateUpload({ filename: "factuur.pdf", declaredMimeType: "application/pdf", size: PDF_SIGNATURE.byteLength, buffer: PDF_SIGNATURE });
    expect(result.mimeType).toBe("application/pdf");
    expect(result.isInlineSafe).toBe(true);
  });

  it("rejects SVG outright — not on the allowlist regardless of content", () => {
    expect(() =>
      validateUpload({ filename: "logo.svg", declaredMimeType: "image/svg+xml", size: 100, buffer: Buffer.from("<svg></svg>") }),
    ).toThrow(FileValidationError);
  });

  it("rejects a file whose content doesn't match the declared mimetype (spoofed Content-Type)", () => {
    // Declares image/png but the actual bytes are HTML — magic-byte check must catch this.
    expect(() =>
      validateUpload({ filename: "innocent.png", declaredMimeType: "image/png", size: FAKE_HTML.byteLength, buffer: FAKE_HTML }),
    ).toThrow(/inhoud/i);
  });

  it("rejects a mismatched extension for an otherwise-valid mimetype", () => {
    expect(() =>
      validateUpload({ filename: "foto.exe", declaredMimeType: "image/png", size: PNG_SIGNATURE.byteLength, buffer: PNG_SIGNATURE }),
    ).toThrow(/extensie/i);
  });

  it("rejects a file exceeding the size limit", () => {
    expect(() =>
      validateUpload({ filename: "groot.pdf", declaredMimeType: "application/pdf", size: MAX_FILE_SIZE_BYTES + 1, buffer: PDF_SIGNATURE }),
    ).toThrow(/groot/i);
  });

  it("rejects an empty file", () => {
    expect(() => validateUpload({ filename: "leeg.pdf", declaredMimeType: "application/pdf", size: 0, buffer: Buffer.alloc(0) })).toThrow(/leeg/i);
  });

  it("rejects a type not on the allowlist (e.g. an executable)", () => {
    expect(() =>
      validateUpload({ filename: "setup.exe", declaredMimeType: "application/x-msdownload", size: 10, buffer: Buffer.from("MZ") }),
    ).toThrow(FileValidationError);
  });

  it("marks a Word document as not inline-safe (forces download, never inline-rendered)", () => {
    const docxBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const result = validateUpload({
      filename: "contract.docx",
      declaredMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: docxBytes.byteLength,
      buffer: docxBytes,
    });
    expect(result.isInlineSafe).toBe(false);
  });

  it("sanitizes a path-traversal-shaped filename to just the base name", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Windows\\evil.pdf")).toBe("evil.pdf");
  });

  it("strips control characters and quotes from a filename (Content-Disposition safety)", () => {
    const sanitized = sanitizeFilename('weird"name\r\n.pdf');
    expect(sanitized).not.toMatch(/["\r\n]/);
  });
});
