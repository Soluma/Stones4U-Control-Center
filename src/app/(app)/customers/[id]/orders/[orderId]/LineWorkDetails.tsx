import type { ShopifyOrderLineItem } from "@/integrations/shopify/order-detail";

/**
 * "Werk" and "Referentie" under a product line — the customer's project and
 * reference for that line, read from the Shopify line item. Renders nothing
 * when neither is filled, so a line without them looks exactly as before.
 * Values are plain text; React escapes them.
 */
export function LineWorkDetails({ line }: { line: Pick<ShopifyOrderLineItem, "werk" | "referentie"> }) {
  if (!line.werk && !line.referentie) return null;
  return (
    <dl className="mt-1 space-y-0.5 text-xs text-ink-secondary">
      {line.werk && (
        <div className="flex gap-1">
          <dt className="shrink-0 font-medium text-ink-tertiary">Werk:</dt>
          <dd className="min-w-0 break-words">{line.werk}</dd>
        </div>
      )}
      {line.referentie && (
        <div className="flex gap-1">
          <dt className="shrink-0 font-medium text-ink-tertiary">Referentie:</dt>
          <dd className="min-w-0 break-words">{line.referentie}</dd>
        </div>
      )}
    </dl>
  );
}
