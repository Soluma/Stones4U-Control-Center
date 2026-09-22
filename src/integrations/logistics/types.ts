import { z } from "zod";

/**
 * The logistics read model OfferteApp exposes for Customer 360
 * (OfferteApp docs/CRM-LOGISTICS-API.md, contract commit 9eb16c5).
 *
 * Every Stones4U rule lives in OfferteApp: it decides handoffType,
 * scheduleState, the Van Eijk pickup day and the Dutch status label. The CRM
 * only presents what it receives — it never re-derives those from status
 * strings, and it never stores any of it (ADR-002/ADR-004: read-through, no
 * second source of truth).
 */

export const HANDOFF_TYPES = ["VAN_EIJK", "HOEFNAGELS", "CUSTOMER_PICKUP", "UNKNOWN"] as const;
export const SCHEDULE_STATES = ["FIXED_DATE", "ON_CALL", "NOT_SET"] as const;

/** An unknown value from a newer OfferteApp must not break the page. */
const handoffType = z.enum(HANDOFF_TYPES).catch("UNKNOWN");
const scheduleState = z.enum(SCHEDULE_STATES).catch("NOT_SET");

const operationalStatus = z.object({
  value: z.string().nullable(),
  label: z.string().nullable(),
});

const pick = z.object({
  started: z.boolean(),
  completed: z.boolean(),
  pickedLines: z.number(),
  totalLines: z.number(),
  deviationCount: z.number(),
  startedAt: z.string().nullable(),
  startedByName: z.string().nullable(),
  completedAt: z.string().nullable(),
  completedByName: z.string().nullable(),
});

const lock = z.object({
  active: z.boolean(),
  claimedByName: z.string().nullable(),
  claimedAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  expires: z.boolean().optional(),
});

const pallets = z.object({ total: z.number(), scanned: z.number() });

const photos = z.object({
  count: z.number(),
  pendingCount: z.number(),
  failedCount: z.number(),
  items: z
    .array(
      z.object({
        shopifyFileGid: z.string(),
        alt: z.string().nullable().optional(),
        createdAt: z.string().nullable().optional(),
        thumbUrl: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
        width: z.number().nullable().optional(),
        height: z.number().nullable().optional(),
        uploadedByName: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

/** Van Eijk and Hoefnagels return different shapes; both stay optional. */
const transport = z
  .object({
    carrier: z.string(),
    jobStatus: z.string().nullable().optional(),
    supplierNumber: z.number().nullable().optional(),
    palletCount: z.number().nullable().optional(),
    palletType: z.string().nullable().optional(),
    labelCount: z.number().nullable().optional(),
    labelsPrintedAt: z.string().nullable().optional(),
    deliveryDate: z.string().nullable().optional(),
    pickupDate: z.string().nullable().optional(),
    sentAt: z.string().nullable().optional(),
    planningGroup: z.string().nullable().optional(),
    plannedAt: z.string().nullable().optional(),
  })
  .nullable();

export const logisticsEventSchema = z.object({
  id: z.string(),
  kind: z.string(),
  occurredAt: z.string(),
  actorName: z.string().nullable().optional(),
  summary: z.string(),
  source: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const summary = z.object({
  shopifyOrderId: z.string(),
  shopifyOrderGid: z.string(),
  orderName: z.string(),
  orderCreatedAt: z.string().nullable().optional(),
  operationalStatus,
  handoffType,
  scheduleState,
  requestedDate: z.string().nullable(),
  deliveryNote: z.string().nullable().optional(),
  pick,
  lock,
  pallets,
  photos,
  transport,
  lastEvent: logisticsEventSchema.nullable().optional(),
});

export const logisticsLineSchema = z.object({
  lineItemId: z.string(),
  lineItemGid: z.string(),
  orderedQuantity: z.number(),
  pickedQuantity: z.number(),
  picked: z.boolean(),
  resolved: z.boolean(),
  deviation: z.string().nullable(),
  deviationNote: z.string().nullable(),
  pickedByName: z.string().nullable(),
  pickedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const logisticsPalletSchema = z.object({
  id: z.string(),
  barcode: z.string(),
  labelPage: z.number().nullable(),
  labelTotal: z.number().nullable(),
  unitLabel: z.string().nullable(),
  scannedAt: z.string().nullable(),
  scannedByName: z.string().nullable(),
  scanSource: z.string().nullable(),
});

export const logisticsSummarySchema = summary;

export const logisticsDetailSchema = summary.extend({
  lines: z.array(logisticsLineSchema).default([]),
  palletDetails: z.array(logisticsPalletSchema).default([]),
  timeline: z.array(logisticsEventSchema).default([]),
});

export const logisticsBatchSchema = z.object({
  orders: z.array(logisticsSummarySchema),
  notFound: z.array(z.string()).default([]),
});

export const logisticsDetailResponseSchema = z.object({ order: logisticsDetailSchema });

export type HandoffType = (typeof HANDOFF_TYPES)[number];
export type ScheduleState = (typeof SCHEDULE_STATES)[number];
export type LogisticsEvent = z.infer<typeof logisticsEventSchema>;
export type LogisticsLine = z.infer<typeof logisticsLineSchema>;
export type LogisticsPallet = z.infer<typeof logisticsPalletSchema>;
export type OrderLogisticsSummary = z.infer<typeof logisticsSummarySchema>;
export type OrderLogisticsDetail = z.infer<typeof logisticsDetailSchema>;
