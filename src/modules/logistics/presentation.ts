import { formatDateLong, formatDateTime } from "@/lib/format";
import type {
  HandoffType,
  LogisticsEvent,
  LogisticsPallet,
  OrderLogisticsSummary,
  ScheduleState,
} from "@/integrations/logistics/types";

/**
 * How logistics data reads in the CRM. Presentation only.
 *
 * Every classification already arrives decided by OfferteApp — handoffType,
 * scheduleState, the operational status label and the Van Eijk pickup day.
 * Nothing here parses a Dutch status string or re-derives meaning; it turns
 * canonical values into Dutch the staff recognise.
 */

export const HANDOFF_LABELS: Record<HandoffType, string> = {
  VAN_EIJK: "Van Eijk",
  HOEFNAGELS: "Hoefnagels",
  CUSTOMER_PICKUP: "Afhalen klant",
  UNKNOWN: "Afhandeling onbekend",
};

export function handoffLabel(handoffType: HandoffType): string {
  return HANDOFF_LABELS[handoffType] ?? HANDOFF_LABELS.UNKNOWN;
}

/** The status as the OfferteApp board names it; its own value as fallback. */
export function statusLabel(status: { value: string | null; label: string | null }): string {
  return status.label?.trim() || status.value?.trim() || "Geen status";
}

export type ScheduleDisplay = { primary: string; secondary: string | null };

/**
 * "Op afroep" wins over any date: an ON_CALL order deliberately has no fixed
 * date yet, and an indicative date stays an indication. A missing date is
 * never ON_CALL — that state comes from OfferteApp, never from a null here.
 */
export function scheduleDisplay(scheduleState: ScheduleState, requestedDate: string | null): ScheduleDisplay {
  if (scheduleState === "ON_CALL") {
    return {
      primary: "Op afroep",
      secondary: requestedDate ? `Indicatie: ${formatDateLong(requestedDate)}` : null,
    };
  }
  if (scheduleState === "FIXED_DATE" && requestedDate) {
    return { primary: formatDateLong(requestedDate), secondary: null };
  }
  return { primary: "Nog geen datum", secondary: null };
}

export function pickProgressLabel(pick: OrderLogisticsSummary["pick"]): string {
  return `${pick.pickedLines} / ${pick.totalLines} regels gepickt`;
}

export function palletProgressLabel(pallets: OrderLogisticsSummary["pallets"]): string | null {
  if (pallets.total === 0) return null;
  return `${pallets.scanned} / ${pallets.total} pallets gescand`;
}

/**
 * Which orders the customer card puts first. Mechanical, from the facts the
 * API returns — never an interpretation of the status text: someone is
 * holding it, picking is underway, or pallets are still waiting to be
 * scanned out.
 */
export function needsAttention(order: OrderLogisticsSummary): boolean {
  if (order.lock.active) return true;
  if (order.pick.started && !order.pick.completed) return true;
  return order.pallets.total > 0 && order.pallets.scanned < order.pallets.total;
}

export const DEVIATION_LABELS: Record<string, string> = {
  SHORTAGE: "Tekort",
  DAMAGED: "Beschadigd",
  NOT_FOUND: "Niet gevonden",
  WRONG_ITEM: "Verkeerd artikel",
  OTHER: "Anders",
};

export function deviationLabel(deviation: string | null): string | null {
  if (!deviation) return null;
  return DEVIATION_LABELS[deviation] ?? deviation;
}

export function scanSourceLabel(scanSource: string | null): string | null {
  if (!scanSource) return null;
  if (scanSource === "camera") return "camera";
  if (scanSource === "manual") return "handmatig";
  return scanSource;
}

export function palletTitle(pallet: LogisticsPallet): string {
  if (pallet.labelPage && pallet.labelTotal) return `Pallet ${pallet.labelPage} / ${pallet.labelTotal}`;
  return "Pallet";
}

export function palletScanLine(pallet: LogisticsPallet): string {
  if (!pallet.scannedAt) return "Nog niet gescand";
  const who = pallet.scannedByName ? ` · ${pallet.scannedByName}` : "";
  const how = scanSourceLabel(pallet.scanSource);
  return `Gescand ${formatDateTime(pallet.scannedAt)}${who}${how ? ` · ${how}` : ""}`;
}

export type DisplayablePhoto = { thumbUrl?: string | null; url?: string | null };

/**
 * Photos that can actually be shown. A Shopify file reference can arrive
 * without either URL (a file still processing, or one whose image was
 * removed); rendering `<img src="">` for it makes the browser re-request
 * the current page, so such an item never reaches the gallery.
 */
export function usablePhotos<T extends DisplayablePhoto>(items: T[] | undefined | null): T[] {
  return (items ?? []).filter((photo) => !!(photo.thumbUrl || photo.url));
}

/** The thumbnail to show: the small one when Shopify gave us one, else the
 *  full image. Only ever called for a photo that passed usablePhotos(). */
export function photoSrc(photo: DisplayablePhoto): string {
  return photo.thumbUrl || photo.url || "";
}

/** The image to open on click: the full one when there is one. */
export function photoHref(photo: DisplayablePhoto): string {
  return photo.url || photo.thumbUrl || "";
}

/** Dutch titles for the event kinds OfferteApp emits. */
export const EVENT_LABELS: Record<string, string> = {
  PICK_STARTED: "Picken gestart",
  PICK_CLAIM_TAKEN_OVER: "Order overgenomen",
  PICK_LINE_UPDATED: "Pickregel bijgewerkt",
  PICK_COMPLETED: "Picken afgerond",
  PALLET_PHOTO_ATTACHED: "Palletfoto toegevoegd",
  PALLET_PHOTO_REMOVED: "Palletfoto verwijderd",
  PALLET_SCANNED: "Pallet gescand",
  PALLET_SCAN_UNDONE: "Palletscan teruggedraaid",
  PALLET_SCAN_CORRECTED: "Palletscan gecorrigeerd",
  VAN_EIJK_PICKUP_COMPLETED: "Opgehaald door Van Eijk",
  CUSTOMER_PICKUP_HANDED_OVER: "Meegegeven aan klant",
  HOEFNAGELS_PICKED_UP: "Opgehaald door Hoefnagels",
  TRANSPORT_CREATED: "Transportopdracht aangemaakt",
  TRANSPORT_SENT: "Doorgezet naar Van Eijk",
  TRANSPORT_SEND_FAILED: "Doorzetten naar Van Eijk mislukt",
  TRANSPORT_LABELS_PRINTED: "Labels geprint",
  TRANSPORT_STATUS_CHANGED: "Transportstatus gewijzigd",
  TRANSPORT_CANCELLED: "Transportopdracht geannuleerd",
};

export function eventLabel(event: Pick<LogisticsEvent, "kind">): string {
  return EVENT_LABELS[event.kind] ?? "Logistieke gebeurtenis";
}

/**
 * order_line_picks keeps only the latest state per line, so a
 * PICK_LINE_UPDATED entry is the last change to that line — not one entry
 * per tap. Saying so beats implying a history that was never recorded.
 */
export function isLatestStateOnly(event: LogisticsEvent): boolean {
  return event.metadata?.latestStateOnly === true;
}

export function eventSummary(event: LogisticsEvent): string {
  return isLatestStateOnly(event) ? `${event.summary} (laatste stand van deze regel)` : event.summary;
}
