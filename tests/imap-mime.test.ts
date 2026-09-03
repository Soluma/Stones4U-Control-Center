import { describe, expect, it } from "vitest";
import { findInlineTextPart, decodeBodyPartPreview } from "@/integrations/email/imap-mime";
import type { MessageStructureObject } from "imapflow";

describe("findInlineTextPart", () => {
  it("finds a single top-level text/plain part", () => {
    const structure: MessageStructureObject = { type: "text/plain", part: "1", parameters: { charset: "utf-8" } };
    expect(findInlineTextPart(structure)).toEqual({ part: "1", type: "text/plain", charset: "utf-8", encoding: undefined });
  });

  it("prefers text/plain over text/html in a multipart/alternative structure", () => {
    const structure: MessageStructureObject = {
      type: "multipart/alternative",
      childNodes: [
        { type: "text/plain", part: "1", parameters: { charset: "utf-8" } },
        { type: "text/html", part: "2", parameters: { charset: "utf-8" } },
      ],
    };
    expect(findInlineTextPart(structure)?.part).toBe("1");
    expect(findInlineTextPart(structure)?.type).toBe("text/plain");
  });

  it("falls back to text/html when no text/plain part exists anywhere", () => {
    const structure: MessageStructureObject = {
      type: "multipart/mixed",
      childNodes: [{ type: "text/html", part: "1", parameters: { charset: "utf-8" } }],
    };
    expect(findInlineTextPart(structure)?.type).toBe("text/html");
  });

  it("excludes a text part that is actually an attachment (Content-Disposition: attachment)", () => {
    const structure: MessageStructureObject = {
      type: "multipart/mixed",
      childNodes: [
        { type: "text/plain", part: "1", disposition: "attachment", parameters: { charset: "utf-8" } },
      ],
    };
    expect(findInlineTextPart(structure)).toBeNull();
  });

  it("returns null for an image-only message — never guesses", () => {
    const structure: MessageStructureObject = { type: "image/jpeg", part: "1" };
    expect(findInlineTextPart(structure)).toBeNull();
  });

  it("returns null for undefined/null input", () => {
    expect(findInlineTextPart(undefined)).toBeNull();
    expect(findInlineTextPart(null)).toBeNull();
  });

  it("finds text/plain nested inside a multipart/mixed > multipart/alternative structure (real-world shape with an attachment)", () => {
    const structure: MessageStructureObject = {
      type: "multipart/mixed",
      childNodes: [
        {
          type: "multipart/alternative",
          childNodes: [
            { type: "text/plain", part: "1.1", parameters: { charset: "utf-8" } },
            { type: "text/html", part: "1.2", parameters: { charset: "utf-8" } },
          ],
        },
        { type: "application/pdf", part: "2", disposition: "attachment" },
      ],
    };
    expect(findInlineTextPart(structure)).toEqual({ part: "1.1", type: "text/plain", charset: "utf-8", encoding: undefined });
  });
});

describe("decodeBodyPartPreview", () => {
  it("decodes a plain-text part", async () => {
    const raw = Buffer.from("Bedankt voor uw bericht, we nemen spoedig contact op.", "utf8");
    const preview = await decodeBodyPartPreview(raw, { part: "1", type: "text/plain", charset: "utf-8" });
    expect(preview).toBe("Bedankt voor uw bericht, we nemen spoedig contact op.");
  });

  it("decodes a quoted-printable encoded part", async () => {
    const raw = Buffer.from("Vraag over uw bestelling =E2=80=94 graag reactie.", "utf8");
    const preview = await decodeBodyPartPreview(raw, { part: "1", type: "text/plain", charset: "utf-8", encoding: "quoted-printable" });
    expect(preview).toContain("Vraag over uw bestelling");
    expect(preview).toContain("—"); // =E2=80=94 decodes to an em dash
  });

  it("safely reduces an HTML-only part to plain text, never returning markup", async () => {
    const raw = Buffer.from("<html><body><p>Hallo <b>klant</b></p><script>evil()</script></body></html>", "utf8");
    const preview = await decodeBodyPartPreview(raw, { part: "1", type: "text/html", charset: "utf-8" });
    expect(preview).not.toContain("<");
    expect(preview).not.toContain("script");
    expect(preview).toContain("Hallo");
    expect(preview).toContain("klant");
  });

  it("truncates a long preview and appends an ellipsis", async () => {
    const raw = Buffer.from("x".repeat(1000), "utf8");
    const preview = await decodeBodyPartPreview(raw, { part: "1", type: "text/plain", charset: "utf-8" });
    expect(preview!.length).toBeLessThanOrEqual(301);
    expect(preview!.endsWith("…")).toBe(true);
  });

  it("returns null (never throws) for empty content", async () => {
    const preview = await decodeBodyPartPreview(Buffer.from("", "utf8"), { part: "1", type: "text/plain" });
    expect(preview).toBeNull();
  });

  it("returns null (never throws) for garbage/malformed bytes, e.g. a byte-capped truncation mid-sequence", async () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x00, 0xd8, 0x00]); // invalid as any common charset
    const preview = await decodeBodyPartPreview(raw, { part: "1", type: "text/plain", charset: "utf-8" });
    // Must not throw — either null or a best-effort string is acceptable.
    expect(preview === null || typeof preview === "string").toBe(true);
  });
});
