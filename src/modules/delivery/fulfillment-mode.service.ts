import "server-only";
import { logAudit } from "@/platform/audit/audit";
import { getOrderForHandoff, type OrderForHandoffResult } from "@/integrations/shopify/order-for-handoff";
import { writeOrderFulfillmentMode } from "@/integrations/shopify/order-fulfillment-mode-mirror";
import { OrderCancelledError, ShopifyApiError } from "@/integrations/shopify/errors";
import type { ExplicitFulfillmentMode, FulfillmentModeResolution } from "@/integrations/shopify/fulfillment-contract";
import type { FulfillmentMode } from "@/integrations/shopify/fulfillment-mode";
import { FulfillmentModeConfirmationRequiredError } from "./errors";

// Phase 6L — the one authoritative service for inspecting and changing an
// Order's explicit Stones4U fulfillment mode.
//
// Nothing about the current state is ever accepted from the client (build
// instruction §5): not the native mode, not the existing explicit value, not
// the resolved mode, not the shop, not the previous value. A caller supplies
// only *which* Order and *what* it should become; every trusted fact is
// re-read from Shopify here, immediately before the decision and the write.
//
// This phase produces trustworthy input data and nothing else. It sends no
// email, creates no handoff, and does not touch the automatic decision —
// READY_FOR_DELIVERY_REQUEST stays unreachable.

/** Current state of an Order's classification, all server-derived. */
export type OrderFulfillmentClassification = {
  orderGid: string;
  orderName: string;
  isCancelled: boolean;
  /** Layer 1 — what Shopify itself says. Never authoritative on its own. */
  nativeFulfillmentMode: FulfillmentMode;
  /** The explicit Stones4U value, or null when absent/invalid/duplicated. */
  explicitFulfillmentMode: ExplicitFulfillmentMode | null;
  /** Layer 2 — the authoritative answer, plus why. */
  resolution: FulfillmentModeResolution;
  /** Present only so staff can see a date exists; never modified here. */
  requestedDeliveryDate: string | null;
};

function toClassification(order: OrderForHandoffResult): OrderFulfillmentClassification {
  return {
    orderGid: order.gid,
    orderName: order.name,
    isCancelled: order.isCancelled,
    nativeFulfillmentMode: order.nativeFulfillmentMode,
    explicitFulfillmentMode: order.explicitFulfillmentMode,
    resolution: order.fulfillmentResolution,
    requestedDeliveryDate: order.requestedDeliveryDate,
  };
}

async function readClassification(orderGid: string): Promise<OrderFulfillmentClassification> {
  const order = await getOrderForHandoff(orderGid);
  if (!order) {
    throw new ShopifyApiError(`Order ${orderGid} bestaat niet (meer) in Shopify.`);
  }
  return toClassification(order);
}

/** Read-only. Any signed-in staff member may inspect a classification. */
export async function getOrderFulfillmentClassification(orderGid: string): Promise<OrderFulfillmentClassification> {
  return readClassification(orderGid);
}

/**
 * Whether an explicit value already exists that a write would overwrite.
 *
 * Derived from the resolution's diagnostic rather than from
 * `explicitFulfillmentMode` alone, because an invalid or duplicated value is
 * *also* an existing choice someone made — overwriting it silently would be
 * exactly the kind of unannounced change staff should have to confirm.
 */
function existingChoiceState(
  classification: OrderFulfillmentClassification,
): { exists: false } | { exists: true; mode: string | null; state: "VALID" | "INVALID" | "DUPLICATE" } {
  if (classification.explicitFulfillmentMode !== null) {
    return { exists: true, mode: classification.explicitFulfillmentMode, state: "VALID" };
  }
  if (classification.resolution.diagnostic === "DUPLICATE_EXPLICIT_KEY") {
    return { exists: true, mode: null, state: "DUPLICATE" };
  }
  if (classification.resolution.diagnostic === "INVALID_EXPLICIT_VALUE") {
    return { exists: true, mode: null, state: "INVALID" };
  }
  return { exists: false };
}

/** Compact description of the current contract state, used purely as an
 * optimistic-concurrency check on a confirmed retry. */
function stateToken(existing: ReturnType<typeof existingChoiceState>): string {
  if (!existing.exists) return "ABSENT";
  return existing.state === "VALID" ? `VALID:${existing.mode}` : existing.state;
}

type ChangeInput = {
  orderGid: string;
  actorId: string;
  /** Staff has seen the current value and confirmed the overwrite. Required
   * only when a choice already exists — never for a first classification. */
  confirmChange?: boolean;
  /** The state token from the confirmation prompt, echoed back unchanged.
   * Must match a fresh server read for the confirmation to count. */
  expectedCurrentState?: string;
};

export type FulfillmentModeChangeResult = {
  classification: OrderFulfillmentClassification;
  /** False when the Order was already in the requested state — a success
   * with no Shopify mutation and no audit entry (build instruction §9). */
  changed: boolean;
  /** True when this write replaced an invalid or duplicated value with one
   * canonical value (build instruction §17). */
  repaired: boolean;
};

async function applyChange(input: ChangeInput & { mode: ExplicitFulfillmentMode | null }): Promise<FulfillmentModeChangeResult> {
  const { orderGid, actorId, confirmChange, expectedCurrentState, mode } = input;

  // 1. Canonical server-side re-read — the basis for every decision below.
  const before = await readClassification(orderGid);

  // 2. A cancelled Order is never editable, and is rejected before any write
  //    is attempted so no audit can ever claim a change that did not happen.
  if (before.isCancelled) {
    throw new OrderCancelledError(orderGid);
  }

  // 3. Confirmation, decided from server-read state only. An idempotent
  //    request changes nothing, so it needs no confirmation.
  const existing = existingChoiceState(before);
  const isNoOp = mode !== null && existing.exists && existing.state === "VALID" && existing.mode === mode;
  const currentStateToken = stateToken(existing);

  // A confirmation authorizes exactly the transition staff were shown, not
  // "any overwrite from now on". The retry echoes back the state it was
  // presented with; that echo is never believed, only compared against this
  // fresh read. If someone else changed the Order in between, the mismatch
  // re-prompts with the new state rather than silently applying the
  // confirmation to a transition nobody saw.
  const staleConfirmation = confirmChange === true && expectedCurrentState !== currentStateToken;

  if (existing.exists && !isNoOp && (confirmChange !== true || staleConfirmation)) {
    throw new FulfillmentModeConfirmationRequiredError({
      currentMode: existing.mode,
      currentState: existing.state,
      requestedMode: mode,
      currentStateToken,
    });
  }

  // 4. The write itself re-reads and merges again, and refuses a cancelled
  //    Order a second time — it is safe to call on its own terms.
  const writeResult = await writeOrderFulfillmentMode(orderGid, mode);

  // 5. Authoritative post-write state, read back rather than assumed.
  const after = await readClassification(orderGid);

  if (!writeResult.written) {
    // Nothing changed in Shopify, so nothing is audited — a repeated click
    // must not accumulate audit noise.
    return { classification: after, changed: false, repaired: false };
  }

  const repaired = existing.exists && existing.state !== "VALID";
  await logAudit({
    userId: actorId,
    action: repaired ? "order_fulfillment_mode.repaired" : mode === null ? "order_fulfillment_mode.cleared" : "order_fulfillment_mode.set",
    entityType: "ShopifyOrder",
    entityId: orderGid,
    metadata: {
      orderName: writeResult.orderName,
      previousState: existing.exists ? existing.state : "ABSENT",
      previousMode: existing.exists ? existing.mode : null,
      newMode: mode,
      duplicatesRemoved: writeResult.duplicatesRemoved,
      // Recorded so a later phase can measure explicit-vs-native agreement
      // without re-reading Shopify (build instruction §23).
      nativeFulfillmentMode: after.nativeFulfillmentMode,
      resolvedMode: after.resolution.mode,
      resolutionDiagnostic: after.resolution.diagnostic,
    },
  });

  return { classification: after, changed: true, repaired };
}

/**
 * Sets the Order's explicit fulfillment mode to one canonical value.
 *
 * `mode` is the only thing the caller decides; the previous value, the
 * native signal and the resolved outcome are all re-read server-side.
 */
export async function setOrderFulfillmentModeForStaff(
  input: ChangeInput & { mode: ExplicitFulfillmentMode },
): Promise<FulfillmentModeChangeResult> {
  return applyChange(input);
}

/**
 * Removes the explicit fulfillment mode, letting the resolver fall back to
 * the native signal alone.
 *
 * This is a deliberately conservative action, not a destructive one: an Order
 * whose explicit CUSTOMER_PICKUP is cleared while Shopify says SHIPPING
 * returns to `UNKNOWN`, which blocks automation rather than enabling it.
 * `requested_delivery_date` is never touched.
 */
export async function clearOrderFulfillmentModeForStaff(input: ChangeInput): Promise<FulfillmentModeChangeResult> {
  return applyChange({ ...input, mode: null });
}
