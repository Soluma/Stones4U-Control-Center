import type { LogisticsLine } from "@/integrations/logistics/types";

/**
 * Joining Shopify's product lines to OfferteApp's pick lines.
 *
 * The join key is the Shopify line-item id and nothing else. Titles and
 * SKUs repeat across lines of the same order — two lines of the same slab
 * in different lengths, a product added twice — so matching on those would
 * silently attach one line's pick state to another line's product. That is
 * the one failure mode this module exists to prevent, which is why a line
 * that cannot be matched is reported rather than dropped.
 */

export type JoinableShopifyLine = {
  gid: string;
  legacyId: string;
};

export type JoinedLine<T extends JoinableShopifyLine> = {
  shopifyLine: T;
  /** null = OfferteApp has no pick row for this line (not "not picked"). */
  pick: LogisticsLine | null;
};

export type LineJoinResult<T extends JoinableShopifyLine> = {
  lines: JoinedLine<T>[];
  /** Lines counted as picked whose Shopify line is not on this order (or
   * not in the first 100): shown as a warning, never hidden, never guessed
   * onto a product. */
  unmatchedPickLines: LogisticsLine[];
  /** Shopify lines OfferteApp has no row for at all. */
  shopifyLinesWithoutPickData: number;
};

export function joinLogisticsLines<T extends JoinableShopifyLine>(
  shopifyLines: T[],
  pickLines: LogisticsLine[],
): LineJoinResult<T> {
  // Both spellings of the same id are indexed so the join works whichever
  // form OfferteApp sends; they are the same line, never two.
  const byKey = new Map<string, LogisticsLine>();
  for (const pick of pickLines) {
    if (pick.lineItemId) byKey.set(pick.lineItemId, pick);
    if (pick.lineItemGid) byKey.set(pick.lineItemGid, pick);
  }

  const matched = new Set<LogisticsLine>();
  const lines = shopifyLines.map((shopifyLine) => {
    const pick = byKey.get(shopifyLine.legacyId) ?? byKey.get(shopifyLine.gid) ?? null;
    if (pick) matched.add(pick);
    return { shopifyLine, pick };
  });

  return {
    lines,
    unmatchedPickLines: pickLines.filter((pick) => !matched.has(pick)),
    shopifyLinesWithoutPickData: lines.filter((line) => line.pick === null).length,
  };
}
