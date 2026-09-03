import type { OpportunityStage, OpportunityStatus, OpportunityLinkType } from "@/generated/prisma";

export type OpportunityStageCode = OpportunityStage;
export type OpportunityStatusCode = OpportunityStatus;
export type OpportunityLinkTypeCode = OpportunityLinkType;

// Shared Dutch labels + business constants for Opportunity — deliberately
// NOT "server-only" (no prisma runtime import, only types) so both the
// service layer and client components can import this one source of truth
// instead of duplicating the label maps (docs/architecture/ADR-009-
// OPPORTUNITY-PIPELINE-MODEL.md).

// Stage codes are fixed per the business decision in Phase 4A's build
// instruction — funnel order only, WON/LOST are never stage values
// (ADR-009 §1).
export const STAGE_ORDER: OpportunityStage[] = [
  "NEW",
  "CONTACTED",
  "NEEDS_DEFINED",
  "QUOTE_PREPARATION",
  "QUOTE_SENT",
  "NEGOTIATION",
];

export const STAGE_LABEL: Record<OpportunityStage, string> = {
  NEW: "Nieuw",
  CONTACTED: "Contact gehad",
  NEEDS_DEFINED: "Behoefte bepaald",
  QUOTE_PREPARATION: "Offerte voorbereiden",
  QUOTE_SENT: "Offerte uitgebracht",
  NEGOTIATION: "Onderhandeling",
};

// Default probability per stage — category A (derived, display/weighting
// only). Never written to Opportunity.probability unless a human explicitly
// sets it (architecture doc §14).
export const STAGE_DEFAULT_PROBABILITY: Record<OpportunityStage, number> = {
  NEW: 10,
  CONTACTED: 25,
  NEEDS_DEFINED: 40,
  QUOTE_PREPARATION: 60,
  QUOTE_SENT: 75,
  NEGOTIATION: 90,
};

export const STATUS_LABEL: Record<OpportunityStatus, string> = {
  OPEN: "Open",
  WON: "Gewonnen",
  LOST: "Verloren",
};

export const LINK_TYPE_LABEL: Record<string, string> = {
  OFFERTEAPP_QUOTE: "Offerte (OfferteApp)",
  S4U_QUOTE_APP_QUOTE: "Offerte (s4u-quote-app)",
  SHOPIFY_DRAFT_ORDER: "Shopify conceptbestelling",
  SHOPIFY_ORDER: "Shopify bestelling",
};

/** The value used for display/weighted-pipeline math: the explicit human
 * value if set, otherwise the stage default. Never persisted as the
 * "real" probability — an explicit human value is never silently
 * overwritten (architecture doc §14/ADR-009). */
export function effectiveProbability(opportunity: { probability: number | null; stage: OpportunityStage }): number {
  return opportunity.probability ?? STAGE_DEFAULT_PROBABILITY[opportunity.stage];
}
