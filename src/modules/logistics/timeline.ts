import type { LogisticsEvent } from "@/integrations/logistics/types";
import type { TimelineItem } from "@/modules/activity/timeline";
import { eventLabel, eventSummary } from "./presentation";

/**
 * Logistics events as Activity Timeline items — projected at render time,
 * never persisted (ADR-004, same contract as the Shopify and telephony
 * projections already in timeline.ts).
 *
 * OfferteApp gives every event a deterministic id built from real database
 * ids (`pallet:87:scanned`, `audit:412`), so the same event keeps the same
 * key across refreshes and can never appear twice.
 */

const ID_PREFIX = "offerteapp-logistics-";

export function logisticsEventToTimelineItem(event: LogisticsEvent): TimelineItem {
  return {
    id: `${ID_PREFIX}${event.id}`,
    occurredAt: new Date(event.occurredAt),
    source: "OFFERTEAPP",
    kind: event.kind,
    title: eventLabel(event),
    summary: eventSummary(event),
    actorName: event.actorName ?? null,
  };
}

/** Newest first, like every other timeline list in the CRM. Events with an
 * unparseable timestamp are dropped rather than sorted as 1970. */
export function logisticsEventsToTimelineItems(events: LogisticsEvent[]): TimelineItem[] {
  const byId = new Map<string, TimelineItem>();
  for (const event of events) {
    const item = logisticsEventToTimelineItem(event);
    if (Number.isNaN(item.occurredAt.getTime())) continue;
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
}

/**
 * Merges logistics events into an existing timeline. Both sides keep their
 * own stable ids, so a merge is idempotent: running it twice adds nothing.
 */
export function mergeLogisticsIntoTimeline(items: TimelineItem[], events: LogisticsEvent[]): TimelineItem[] {
  const merged = new Map<string, TimelineItem>();
  for (const item of [...items, ...logisticsEventsToTimelineItems(events)]) merged.set(item.id, item);
  return [...merged.values()].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
}
