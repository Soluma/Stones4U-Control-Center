import "server-only";
import { createLogisticsAdapter, legacyOrderId } from "@/integrations/logistics/adapter";
import type { PickupEventSource } from "./on-account.service";

/** The only pickup trigger in v1: OfferteApp's audit event
 * customer_pickup_handed_over (Pick App "Meegegeven aan klant"), exposed as
 * timeline kind CUSTOMER_PICKUP_HANDED_OVER with a stable id "audit:<id>".
 * Never the generic status "Afgeleverd / Opgehaald", never a carrier pickup. */
export const PICKUP_HANDOVER_KIND = "CUSTOMER_PICKUP_HANDED_OVER";

export const offerteAppPickupEvents: PickupEventSource = async (orderGid) => {
  const adapter = createLogisticsAdapter();
  if (!adapter.status().available) return null;
  const legacyId = legacyOrderId(orderGid);
  if (!legacyId) return [];
  const result = await adapter.getForOrder(legacyId);
  if (!result.ok) return result.reason === "not_found" ? [] : null;
  return result.order.timeline
    .filter((event) => event.kind === PICKUP_HANDOVER_KIND)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .map((event) => ({ id: event.id, occurredAt: event.occurredAt }));
};
