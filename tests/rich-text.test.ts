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

  it("preserves a single line break within a paragraph as a hardBreak node instead of joining with a space", () => {
    const doc = parsePlainTextToRichDoc("hallo\nhallo");
    expect(() => richTextDocSchema.parse(doc)).not.toThrow();

    expect(doc.content).toHaveLength(1);
    const paragraph = doc.content[0];
    expect(paragraph?.type).toBe("paragraph");
    expect(paragraph?.type === "paragraph" && paragraph.children).toEqual([
      { type: "text", text: "hallo" },
      { type: "hardBreak" },
      { type: "text", text: "hallo" },
    ]);

    expect(richDocToPlainText(doc)).toBe("hallo\nhallo");
  });

  it("preserves three lines within one paragraph as two hardBreak nodes", () => {
    const doc = parsePlainTextToRichDoc("regel1\nregel2\nregel3");
    expect(doc.content).toHaveLength(1);
    expect(richDocToPlainText(doc)).toBe("regel1\nregel2\nregel3");
  });

  it("still treats a blank line (double newline) as a paragraph break, not a hardBreak", () => {
    const doc = parsePlainTextToRichDoc("regel1\n\nregel2");
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0]?.type).toBe("paragraph");
    expect(doc.content[1]?.type).toBe("paragraph");
    expect(richDocToPlainText(doc)).toBe("regel1\n\nregel2");
  });

  it("keeps line breaks stable across an edit round-trip (parse -> plain text -> parse again)", () => {
    const original = parsePlainTextToRichDoc("hallo\nhallo");
    const editedDraft = richDocToPlainText(original); // what the edit textarea is seeded with
    const reparsed = parsePlainTextToRichDoc(editedDraft);
    expect(reparsed).toEqual(original);
  });
});
