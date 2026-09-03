import "server-only";
import { simpleParser } from "mailparser";
import type { MessageStructureObject } from "imapflow";

// MIME helpers for the IMAP adapter — deliberately narrow: locate ONE
// inline text part and turn its (already size-capped) bytes into a short,
// safe plain-text preview. Never touches attachments, never renders HTML,
// never keeps a full message body around.

export type TextPartRef = {
  part: string;
  type: "text/plain" | "text/html";
  charset?: string;
  encoding?: string;
};

/** Walks a message's BODYSTRUCTURE to find the first genuine inline text
 * part — explicitly excludes anything with Content-Disposition: attachment
 * (a .txt/.html *file* attached to the message is not the message body).
 * Prefers text/plain; falls back to text/html only when no plain part
 * exists anywhere in the tree. Returns null (never a guess) when no usable
 * inline text part is found — e.g. an image-only message. */
export function findInlineTextPart(node: MessageStructureObject | undefined | null): TextPartRef | null {
  if (!node) return null;

  if (!node.childNodes || node.childNodes.length === 0) {
    const type = node.type?.toLowerCase();
    const isAttachment = node.disposition?.toLowerCase() === "attachment";
    if ((type === "text/plain" || type === "text/html") && !isAttachment && node.part) {
      return { part: node.part, type: type as "text/plain" | "text/html", charset: node.parameters?.charset, encoding: node.encoding };
    }
    return null;
  }

  let htmlFallback: TextPartRef | null = null;
  for (const child of node.childNodes) {
    const found = findInlineTextPart(child);
    if (found?.type === "text/plain") return found;
    if (found?.type === "text/html" && !htmlFallback) htmlFallback = found;
  }
  return htmlFallback;
}

const PREVIEW_MAX_LENGTH = 300;

/** Decodes ONE already-fetched, size-capped body part (never the full
 * message, never an attachment) into a short plain-text preview.
 *
 * Reuses mailparser's own content-transfer-encoding/charset/HTML-to-text
 * handling by wrapping the raw part bytes in a minimal synthetic
 * single-part message built from the part's own known Content-Type/
 * Content-Transfer-Encoding (from BODYSTRUCTURE) — mailparser never sees
 * the original multipart structure or any attachment, so it cannot surface
 * attachment content even if it wanted to. mailparser's `.text` is already
 * the safe plain-text form (it derives one from HTML internally via its
 * own html-to-text dependency) — this code never touches `.html` and never
 * renders markup.
 *
 * Never throws — a truncated/malformed part (the byte cap can cut an
 * encoded sequence mid-way) degrades to null, not a crash. */
export async function decodeBodyPartPreview(raw: Buffer, partRef: TextPartRef): Promise<string | null> {
  try {
    const contentTypeHeader = `Content-Type: ${partRef.type}${partRef.charset ? `; charset=${partRef.charset}` : ""}`;
    const encodingHeader = partRef.encoding ? `\r\nContent-Transfer-Encoding: ${partRef.encoding}` : "";
    const synthetic = Buffer.concat([Buffer.from(`${contentTypeHeader}${encodingHeader}\r\n\r\n`, "utf8"), raw]);

    const parsed = await simpleParser(synthetic, { skipHtmlToText: false });
    const text = (parsed.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    return text.length > PREVIEW_MAX_LENGTH ? `${text.slice(0, PREVIEW_MAX_LENGTH)}…` : text;
  } catch (error) {
    console.error("imap_body_preview_decode_failed", error instanceof Error ? error.message : "unknown");
    return null;
  }
}
