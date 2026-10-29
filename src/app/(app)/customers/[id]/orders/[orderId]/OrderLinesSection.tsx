import type { ShopifyOrderLineItem } from "@/integrations/shopify/order-detail";
import { LineWorkDetails } from "./LineWorkDetails";

/**
 * "Orderregels" — the product lines exactly as the Shopify order has them,
 * with the customer's Werk / Referentie per line. Built from the Shopify
 * order alone: it shows the same whether OfferteApp answers, has never heard
 * of this order, or is down. Pick progress stays in "Magazijn & logistiek".
 */
export function OrderLinesSection({
  lines,
  hasMoreLineItems,
}: {
  lines: ShopifyOrderLineItem[];
  hasMoreLineItems: boolean;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-ink-secondary">Orderregels</h2>
      <div className="cc-card overflow-hidden">
        {lines.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-tertiary">Deze order heeft geen orderregels.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {lines.map((line) => (
              <li key={line.gid} className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-ink-primary">{line.title}</p>
                  {(line.variantTitle || line.sku) && (
                    <p className="text-xs text-ink-tertiary">
                      {[line.variantTitle, line.sku ? `Art.nr. ${line.sku}` : null].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  <LineWorkDetails line={line} />
                </div>
                <p className="shrink-0 text-right tabular-nums text-ink-secondary">
                  {line.currentQuantity} ×
                  {line.currentQuantity !== line.quantity && (
                    <span className="block text-xs text-ink-tertiary">besteld {line.quantity}</span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
        {hasMoreLineItems && (
          <p className="border-t border-border-subtle px-4 py-2.5 text-sm text-ink-tertiary">
            Deze order heeft meer dan 100 regels; alleen de eerste 100 staan hier. Bekijk de volledige order in Shopify Admin.
          </p>
        )}
      </div>
    </section>
  );
}
