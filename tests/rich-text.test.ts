import { describe, expect, it } from "vitest";
import { parsePlainTextToRichDoc, richDocToPlainText, richTextDocSchema } from "@/platform/security/rich-text";

describe("rich text", () => {
  it("parses bold/italic/code marks and produces a schema-valid doc", () => {
    const doc = parsePlainTextToRichDoc("This is **bold**, *italic*, and `code`.");
    expect(() => richTextDocSchema.parse(doc)).not.toThrow();

    const paragraph = doc.content[0];
    expect(paragraph?.type).toBe("paragraph");
  });

  it("parses bullet lists from '- ' prefixed lines", () => {
    const doc = parsePlainTextToRichDoc("- eerste\n- tweede");
    expect(doc.content[0]?.type).toBe("bullet_list");
  });

  it("round-trips to equivalent plain text", () => {
    const doc = parsePlainTextToRichDoc("Hallo klant, bel morgen terug.");
    expect(richDocToPlainText(doc)).toBe("Hallo klant, bel morgen terug.");
  });

  it("rejects a doc shape outside the closed schema (e.g. raw HTML injection attempt)", () => {
    const malicious = { type: "doc", content: [{ type: "html", raw: "<script>alert(1)</script>" }] };
    expect(() => richTextDocSchema.parse(malicious)).toThrow();
  });
});
