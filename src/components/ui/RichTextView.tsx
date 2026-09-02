import type { RichTextDoc, RichTextInlineNode } from "@/platform/security/rich-text";

// Renders the structured Note.bodyJson tree directly to React elements.
// There is no dangerouslySetInnerHTML anywhere in this file (or anywhere in
// Control Center) — the stored format is a closed node tree, not HTML, so
// there is nothing to sanitize at render time, only to map.

function InlineNode({ node, key }: { node: RichTextInlineNode; key: number }) {
  if (node.type === "link") {
    return (
      <a key={key} href={node.href} target="_blank" rel="noreferrer noopener" className="text-accent-600 underline underline-offset-2">
        {node.text}
      </a>
    );
  }

  const marks = node.marks ?? [];
  let content: React.ReactNode = node.text;
  if (marks.some((m) => m.type === "code")) {
    content = <code className="rounded bg-canvas px-1 py-0.5 font-mono text-[0.85em]">{content}</code>;
  }
  if (marks.some((m) => m.type === "bold")) {
    content = <strong className="font-semibold">{content}</strong>;
  }
  if (marks.some((m) => m.type === "italic")) {
    content = <em>{content}</em>;
  }
  return <span key={key}>{content}</span>;
}

export function RichTextView({ doc }: { doc: RichTextDoc }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed text-ink-primary">
      {doc.content.map((block, blockIndex) => {
        if (block.type === "paragraph") {
          return (
            <p key={blockIndex}>
              {block.children.map((node, i) => (
                <InlineNode key={i} node={node} />
              ))}
            </p>
          );
        }
        return (
          <ul key={blockIndex} className="list-disc space-y-1 pl-5">
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>
                {item.map((node, i) => (
                  <InlineNode key={i} node={node} />
                ))}
              </li>
            ))}
          </ul>
        );
      })}
    </div>
  );
}
