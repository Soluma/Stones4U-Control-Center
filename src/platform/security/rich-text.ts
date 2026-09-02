import { z } from "zod";

// Structured rich-text format for Note.bodyJson. Deliberately NOT HTML —
// this is a small, closed node tree that a renderer maps directly to React
// elements (see src/components/ui/RichTextView.tsx), so there is never a
// dangerouslySetInnerHTML call anywhere in Control Center and never a raw
// HTML string in the database. Small on purpose (paragraphs, bullet lists,
// bold/italic/code marks, links) — enough to be genuinely useful in Phase 1
// without building a full editor framework.

const markSchema = z.union([
  z.object({ type: z.literal("bold") }),
  z.object({ type: z.literal("italic") }),
  z.object({ type: z.literal("code") }),
]);

const textNodeSchema = z.object({
  type: z.literal("text"),
  text: z.string().max(10_000),
  marks: z.array(markSchema).max(4).optional(),
});

const linkNodeSchema = z.object({
  type: z.literal("link"),
  href: z.string().url().max(2000),
  text: z.string().max(500),
});

const inlineNodeSchema = z.union([textNodeSchema, linkNodeSchema]);

const paragraphNodeSchema = z.object({
  type: z.literal("paragraph"),
  children: z.array(inlineNodeSchema).max(500),
});

const bulletListNodeSchema = z.object({
  type: z.literal("bullet_list"),
  items: z.array(z.array(inlineNodeSchema).max(200)).max(200),
});

const blockNodeSchema = z.union([paragraphNodeSchema, bulletListNodeSchema]);

export const richTextDocSchema = z.object({
  type: z.literal("doc"),
  content: z.array(blockNodeSchema).min(1).max(500),
});

export type RichTextMark = z.infer<typeof markSchema>;
export type RichTextInlineNode = z.infer<typeof inlineNodeSchema>;
export type RichTextBlockNode = z.infer<typeof blockNodeSchema>;
export type RichTextDoc = z.infer<typeof richTextDocSchema>;

// Phase 1 editor is a plain textarea with a tiny markdown-like subset
// (**bold**, *italic*, `code`, "- " bullet lines, blank line = new
// paragraph) — parsed here into the structured doc. This gives real rich
// text without shipping a WYSIWYG editor dependency in Phase 1.
export function parsePlainTextToRichDoc(input: string): RichTextDoc {
  const normalized = input.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return { type: "doc", content: [{ type: "paragraph", children: [{ type: "text", text: "" }] }] };
  }

  const blocks: RichTextBlockNode[] = [];
  const chunks = normalized.split(/\n{2,}/);

  for (const chunk of chunks) {
    const lines = chunk.split("\n").filter((l) => l.length > 0);
    const isBulletList = lines.length > 0 && lines.every((l) => /^[-*]\s+/.test(l));

    if (isBulletList) {
      blocks.push({
        type: "bullet_list",
        items: lines.map((line) => parseInline(line.replace(/^[-*]\s+/, ""))),
      });
    } else {
      blocks.push({ type: "paragraph", children: parseInline(chunk.replace(/\n/g, " ")) });
    }
  }

  return { type: "doc", content: blocks.length > 0 ? blocks : [{ type: "paragraph", children: [{ type: "text", text: "" }] }] };
}

function parseInline(text: string): RichTextInlineNode[] {
  const nodes: RichTextInlineNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push({ type: "text", text: token.slice(2, -2), marks: [{ type: "bold" }] });
    } else if (token.startsWith("*")) {
      nodes.push({ type: "text", text: token.slice(1, -1), marks: [{ type: "italic" }] });
    } else {
      nodes.push({ type: "text", text: token.slice(1, -1), marks: [{ type: "code" }] });
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push({ type: "text", text: text.slice(lastIndex) });
  }

  return nodes.length > 0 ? nodes : [{ type: "text", text: "" }];
}

// Always-derived plain-text projection, stored alongside bodyJson for
// search/preview — never edited independently, never the source of truth.
export function richDocToPlainText(doc: RichTextDoc): string {
  return doc.content
    .map((block) => {
      if (block.type === "paragraph") {
        return block.children.map(inlineToText).join("");
      }
      return block.items.map((item) => `- ${item.map(inlineToText).join("")}`).join("\n");
    })
    .join("\n\n")
    .trim();
}

function inlineToText(node: RichTextInlineNode): string {
  return node.type === "text" ? node.text : node.text;
}
