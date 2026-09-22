import { describe, expect, it } from "vitest";
import type { LogisticsEvent, LogisticsLine, OrderLogisticsSummary } from "@/integrations/logistics/types";
import {
  deviationLabel,
  lineStateDisplay,
  photoHref,
  photoSrc,
  usablePhotos,
  eventLabel,
  eventSummary,
  handoffLabel,
  needsAttention,
  palletScanLine,
  palletTitle,
  scheduleDisplay,
  statusLabel,
} from "@/modules/logistics/presentation";
import { joinLogisticsLines } from "@/modules/logistics/line-join";
import { logisticsEventsToTimelineItems, mergeLogisticsIntoTimeline } from "@/modules/logistics/timeline";
import type { TimelineItem } from "@/modules/activity/timeline";

// OfferteApp decides what an order *is*; the CRM only decides how to say it
// in Dutch. These tests pin the two rules that cost the most if they drift:
// "Op afroep" is never inferred from a missing date, and pick lines are
// matched on the Shopify line-item id and nothing else.

function line(overrides: Partial<LogisticsLine> = {}): LogisticsLine {
  return {
    lineItemId: "55",
    lineItemGid: "gid://shopify/LineItem/55",
    orderedQuantity: 2,
    pickedQuantity: 2,
    picked: true,
    resolved: true,
    deviation: null,
    deviationNote: null,
    pickedByName: "Fons",
    pickedAt: "2026-09-22T07:30:00Z",
    updatedAt: "2026-09-22T07:30:00Z",
    ...overrides,
  };
}

function order(overrides: Partial<OrderLogisticsSummary> = {}): OrderLogisticsSummary {
  return {
    shopifyOrderId: "1",
    shopifyOrderGid: "gid://shopify/Order/1",
    orderName: "#1474",
    orderCreatedAt: "2026-09-21T15:12:03Z",
    operationalStatus: { value: "Klaar voor ophalen transporteur", label: "Klaar ophalen van Eijk" },
    handoffType: "VAN_EIJK",
    scheduleState: "FIXED_DATE",
    requestedDate: "2026-09-24",
    deliveryNote: null,
    pick: {
      started: true,
      completed: true,
      pickedLines: 4,
      totalLines: 4,
      deviationCount: 0,
      startedAt: null,
      startedByName: null,
      completedAt: "2026-09-22T08:00:00Z",
      completedByName: "Fons",
    },
    lock: { active: false, claimedByName: null, claimedAt: null, lastActivityAt: null },
    pallets: { total: 5, scanned: 5 },
    photos: { count: 0, pendingCount: 0, failedCount: 0 },
    transport: null,
    ...overrides,
  };
}

describe("handoff and status labels", () => {
  it("names the four canonical handoff types in Dutch", () => {
    expect(handoffLabel("VAN_EIJK")).toBe("Van Eijk");
    expect(handoffLabel("HOEFNAGELS")).toBe("Hoefnagels");
    expect(handoffLabel("CUSTOMER_PICKUP")).toBe("Afhalen klant");
    expect(handoffLabel("UNKNOWN")).toBe("Afhandeling onbekend");
  });

  it("shows OfferteApp's own board label, never a re-interpretation of the stored value", () => {
    expect(statusLabel({ value: "Klaar voor ophalen transporteur", label: "Klaar ophalen van Eijk" })).toBe(
      "Klaar ophalen van Eijk",
    );
    expect(statusLabel({ value: "Wacht op klant", label: null })).toBe("Wacht op klant");
    expect(statusLabel({ value: null, label: null })).toBe("Geen status");
  });
});

describe("schedule display", () => {
  it("puts 'Op afroep' first and keeps a known date as an indication", () => {
    expect(scheduleDisplay("ON_CALL", null)).toEqual({ primary: "Op afroep", secondary: null });
    expect(scheduleDisplay("ON_CALL", "2026-10-05")).toEqual({
      primary: "Op afroep",
      secondary: "Indicatie: 5 oktober 2026",
    });
  });

  it("shows a fixed date as the date itself", () => {
    expect(scheduleDisplay("FIXED_DATE", "2026-09-24").primary).toBe("24 september 2026");
  });

  it("never turns a missing date into 'Op afroep'", () => {
    expect(scheduleDisplay("NOT_SET", null)).toEqual({ primary: "Nog geen datum", secondary: null });
    expect(scheduleDisplay("FIXED_DATE", null)).toEqual({ primary: "Nog geen datum", secondary: null });
  });
});

describe("needsAttention", () => {
  it("is false for a finished order", () => {
    expect(needsAttention(order())).toBe(false);
  });

  it("is true while someone holds the order, while picking runs, or while pallets are unscanned", () => {
    expect(needsAttention(order({ lock: { active: true, claimedByName: "Fons", claimedAt: null, lastActivityAt: null } }))).toBe(true);
    expect(needsAttention(order({ pick: { ...order().pick, started: true, completed: false } }))).toBe(true);
    expect(needsAttention(order({ pallets: { total: 5, scanned: 2 } }))).toBe(true);
  });

  it("is false for an order with no pallets at all — a customer pickup is not 'unscanned'", () => {
    expect(needsAttention(order({ handoffType: "CUSTOMER_PICKUP", pallets: { total: 0, scanned: 0 } }))).toBe(false);
  });
});

describe("pallet and deviation wording", () => {
  const pallet = {
    id: "87",
    barcode: "123456789012345678",
    labelPage: 1,
    labelTotal: 5,
    unitLabel: "EUR",
    scannedAt: "2026-09-23T09:15:00Z",
    scannedByName: "Fons",
    scanSource: "camera",
  };

  it("numbers a pallet by its own label", () => {
    expect(palletTitle(pallet)).toBe("Pallet 1 / 5");
    expect(palletTitle({ ...pallet, labelPage: null, labelTotal: null })).toBe("Pallet");
  });

  it("says when a pallet was scanned, by whom and how — and says plainly when it was not", () => {
    expect(palletScanLine(pallet)).toContain("Fons");
    expect(palletScanLine(pallet)).toContain("camera");
    expect(palletScanLine({ ...pallet, scanSource: "manual" })).toContain("handmatig");
    expect(palletScanLine({ ...pallet, scannedAt: null })).toBe("Nog niet gescand");
  });

  it("translates the known deviations and passes an unknown one through untouched", () => {
    expect(deviationLabel("SHORTAGE")).toBe("Tekort");
    expect(deviationLabel("IETS_NIEUWS")).toBe("IETS_NIEUWS");
    expect(deviationLabel(null)).toBeNull();
  });
});

describe("joining Shopify lines to pick lines", () => {
  const shopifyLines = [
    { gid: "gid://shopify/LineItem/55", legacyId: "55", title: "Graniet 60x60" },
    { gid: "gid://shopify/LineItem/56", legacyId: "56", title: "Graniet 60x60" },
  ];

  it("matches on the line-item id, never on the title two lines share", () => {
    const result = joinLogisticsLines(shopifyLines, [line({ lineItemId: "56", lineItemGid: "gid://shopify/LineItem/56" })]);

    expect(result.lines[0]?.pick).toBeNull();
    expect(result.lines[1]?.pick?.lineItemId).toBe("56");
    expect(result.shopifyLinesWithoutPickData).toBe(1);
    expect(result.unmatchedPickLines).toEqual([]);
  });

  it("matches on the GID too — the same line, never counted twice", () => {
    const result = joinLogisticsLines(shopifyLines, [line({ lineItemId: "", lineItemGid: "gid://shopify/LineItem/55" })]);

    expect(result.lines[0]?.pick).not.toBeNull();
    expect(result.unmatchedPickLines).toEqual([]);
  });

  it("reports a pick line whose Shopify line is missing instead of attaching it to a product", () => {
    const result = joinLogisticsLines(shopifyLines, [line({ lineItemId: "999", lineItemGid: "gid://shopify/LineItem/999" })]);

    expect(result.unmatchedPickLines).toHaveLength(1);
    expect(result.lines.every((joined) => joined.pick === null)).toBe(true);
  });
});

describe("how one pick line reads", () => {
  // OfferteApp only flips `picked` when the whole sheet is finalised, so
  // during a pick a complete line still arrives as picked: false. The CRM
  // may say what the numbers say — it may not invent a status.

  it("an active pick with the full quantity reads as complete, and says the sheet is not finished", () => {
    const state = lineStateDisplay(line({ picked: false, pickedQuantity: 3, orderedQuantity: 3 }), false);

    expect(state.label).toBe("Compleet gepickt");
    expect(state.hint).toBe("Pickbon nog niet afgerond");
    expect(state.tone).toBe("accent");
    expect(state.label).not.toBe("Open");
  });

  it("an active pick that is short stays open", () => {
    const state = lineStateDisplay(line({ picked: false, pickedQuantity: 2, orderedQuantity: 3 }), false);

    expect(state.label).toBe("Open");
    expect(state.hint).toBeNull();
    expect(state.tone).toBe("neutral");
  });

  it("a finished pick reads as picked, with nothing left to explain", () => {
    const state = lineStateDisplay(line({ picked: true, pickedQuantity: 3, orderedQuantity: 3 }), true);

    expect(state.label).toBe("Gepickt");
    expect(state.hint).toBeNull();
    expect(state.tone).toBe("success");
  });

  it("never claims a line is finished just because the sheet is", () => {
    const state = lineStateDisplay(line({ picked: false, pickedQuantity: 1, orderedQuantity: 2 }), true);

    expect(state.label).toBe("Open");
    expect(state.hint).toBeNull();
  });

  it("leaves the deviation untouched on a line whose quantity is complete", () => {
    const shortage = line({ picked: false, pickedQuantity: 3, orderedQuantity: 3, deviation: "SHORTAGE",
                            deviationNote: "TEST - 1 stuk tekort" });
    const state = lineStateDisplay(shortage, false);

    // The state says nothing about the deviation; the deviation is rendered
    // beside it and keeps its own label and note.
    expect(state.label).toBe("Compleet gepickt");
    expect(deviationLabel(shortage.deviation)).toBe("Tekort");
    expect(shortage.deviationNote).toBe("TEST - 1 stuk tekort");
  });

  it("treats a line with no ordered quantity as open rather than complete", () => {
    expect(lineStateDisplay(line({ picked: false, pickedQuantity: 0, orderedQuantity: 0 }), false).label).toBe("Open");
  });
});

describe("photos that can actually be shown", () => {
  const withBoth = { thumbUrl: "https://cdn/thumb.jpg", url: "https://cdn/full.jpg" };
  const thumbOnly = { thumbUrl: "https://cdn/thumb.jpg", url: null };
  const fullOnly = { thumbUrl: null, url: "https://cdn/full.jpg" };
  const neither = { thumbUrl: null, url: null };

  it("drops a photo that has neither a thumbnail nor a full image", () => {
    expect(usablePhotos([withBoth, neither, thumbOnly, fullOnly])).toEqual([withBoth, thumbOnly, fullOnly]);
    expect(usablePhotos([neither])).toEqual([]);
    expect(usablePhotos(undefined)).toEqual([]);
    expect(usablePhotos([{ thumbUrl: "", url: "" }])).toEqual([]);
  });

  it("never yields an empty src or href for a photo it keeps", () => {
    for (const photo of usablePhotos([withBoth, thumbOnly, fullOnly, neither])) {
      expect(photoSrc(photo)).not.toBe("");
      expect(photoHref(photo)).not.toBe("");
    }
  });

  it("prefers the thumbnail for display and the full image for opening", () => {
    expect(photoSrc(withBoth)).toBe("https://cdn/thumb.jpg");
    expect(photoHref(withBoth)).toBe("https://cdn/full.jpg");
    expect(photoSrc(fullOnly)).toBe("https://cdn/full.jpg");
    expect(photoHref(thumbOnly)).toBe("https://cdn/thumb.jpg");
  });
});

describe("logistics events in the Activity Timeline", () => {
  function event(overrides: Partial<LogisticsEvent> = {}): LogisticsEvent {
    return {
      id: "pallet:87:scanned",
      kind: "PALLET_SCANNED",
      occurredAt: "2026-09-23T09:15:00Z",
      actorName: "Fons",
      summary: "Pallet 1/5 gescand",
      source: "PALLET",
      ...overrides,
    };
  }

  it("keeps OfferteApp's deterministic ids, so the same event never appears twice", () => {
    const items = logisticsEventsToTimelineItems([event(), event()]);

    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item?.id).toBe("offerteapp-logistics-pallet:87:scanned");
    expect(item?.source).toBe("OFFERTEAPP");
    expect(item?.title).toBe("Pallet gescand");
    expect(item?.actorName).toBe("Fons");
  });

  it("orders newest first and drops an unparseable timestamp rather than sorting it as 1970", () => {
    const items = logisticsEventsToTimelineItems([
      event({ id: "a", occurredAt: "2026-09-21T09:00:00Z" }),
      event({ id: "b", occurredAt: "2026-09-23T09:00:00Z" }),
      event({ id: "c", occurredAt: "geen datum" }),
    ]);

    expect(items.map((item) => item.id)).toEqual(["offerteapp-logistics-b", "offerteapp-logistics-a"]);
  });

  it("says when a line event is only the last state of that line, not its history", () => {
    const latestOnly = event({
      id: "line_pick:12",
      kind: "PICK_LINE_UPDATED",
      summary: "2 van 2 gepickt",
      metadata: { latestStateOnly: true },
    });

    expect(eventSummary(latestOnly)).toBe("2 van 2 gepickt (laatste stand van deze regel)");
    expect(eventSummary(event())).toBe("Pallet 1/5 gescand");
  });

  it("says a thing once: a summary identical to the title is dropped", () => {
    const [photo] = logisticsEventsToTimelineItems([
      event({ id: "p1", kind: "PALLET_PHOTO_ATTACHED", summary: "Palletfoto toegevoegd" }),
    ]);
    expect(photo?.title).toBe("Palletfoto toegevoegd");
    expect(photo?.summary).toBeNull();

    // Same words, different spacing and case — still one line.
    const [started] = logisticsEventsToTimelineItems([
      event({ id: "p2", kind: "PICK_STARTED", summary: "  picken   GESTART " }),
    ]);
    expect(started?.summary).toBeNull();
  });

  it("keeps a summary that actually adds something", () => {
    const [scanned] = logisticsEventsToTimelineItems([event({ summary: "Pallet 1/5 gescand" })]);
    expect(scanned?.title).toBe("Pallet gescand");
    expect(scanned?.summary).toBe("Pallet 1/5 gescand");
  });

  it("falls back to a neutral title for an event kind this CRM has not seen yet", () => {
    expect(eventLabel({ kind: "IETS_NIEUWS" })).toBe("Logistieke gebeurtenis");
  });

  it("merges into an existing timeline idempotently and in chronological order", () => {
    const existing: TimelineItem[] = [
      {
        id: "shopify-order-gid://shopify/Order/1",
        occurredAt: new Date("2026-09-22T10:00:00Z"),
        source: "SHOPIFY",
        kind: "SHOPIFY_ORDER",
        title: "Bestelling #1474",
      },
    ];
    const events = [event({ id: "x", occurredAt: "2026-09-23T09:00:00Z" }), event({ id: "y", occurredAt: "2026-09-21T09:00:00Z" })];

    const once = mergeLogisticsIntoTimeline(existing, events);
    const twice = mergeLogisticsIntoTimeline(once, events);

    expect(once.map((item) => item.id)).toEqual([
      "offerteapp-logistics-x",
      "shopify-order-gid://shopify/Order/1",
      "offerteapp-logistics-y",
    ]);
    expect(twice.map((item) => item.id)).toEqual(once.map((item) => item.id));
  });
});
