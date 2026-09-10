// DeliveryHandoffError — thrown for anything the public /delivery/[token]
// flow should show the customer as a clean, non-stack-trace message.
// `retryable: true` means the customer's chosen date is still safe to
// resubmit as-is (a transient Shopify failure); `retryable: false` means
// either the input itself was invalid or the request can never succeed as
// posed (e.g. an unsupported payment provider) — resubmitting the exact
// same thing will not help.
export class DeliveryHandoffError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = "DeliveryHandoffError";
    this.retryable = options?.retryable ?? false;
  }
}

// Phase 6E — thrown by createOrderDeliveryHandoffForStaff() when Shopify's
// Order already carries a requested_delivery_date and no local handoff
// exists yet for it, and staff has not explicitly confirmed they still
// want a new one. Deliberately a distinct type from DeliveryHandoffError
// (which the public flow's error responses assume are always safe,
// customer-facing 400s) — this one is staff-facing only, maps to its own
// 409 response shape, and carries the actual date value so the route can
// hand it back for the confirmation prompt. See that function's own doc
// comment for the full provenance-neutral reasoning: an existing date
// found on an Order does NOT mean it came from the customer portal.
// Phase 6L — thrown when staff try to change or clear an Order's explicit
// fulfillment mode that already has one, without having confirmed it. Like
// ExistingRequestedDeliveryDateError this is staff-facing only, maps to its
// own 409, and carries server-read state for the confirmation prompt — the
// client never supplies (and is never trusted for) the current value.
//
// A first classification never raises this: there is nothing to overwrite.
export class FulfillmentModeConfirmationRequiredError extends Error {
  /** Canonical current value, or null when one exists but is unusable
   * (invalid or duplicated) — `currentState` says which. */
  readonly currentMode: string | null;
  readonly currentState: "VALID" | "INVALID" | "DUPLICATE";
  /** The canonical value staff asked for, or null for a clear. */
  readonly requestedMode: string | null;
  /** Opaque description of the state staff are being shown, echoed back on
   * the confirmed retry so the server can prove the transition it applies is
   * the one that was actually presented. Never trusted as a source of truth
   * — only compared against a fresh read. */
  readonly currentStateToken: string;

  constructor(input: {
    currentMode: string | null;
    currentState: "VALID" | "INVALID" | "DUPLICATE";
    requestedMode: string | null;
    currentStateToken: string;
  }) {
    super("Deze bestelling heeft al een handmatige keuze — bevestig de wijziging.");
    this.name = "FulfillmentModeConfirmationRequiredError";
    this.currentMode = input.currentMode;
    this.currentState = input.currentState;
    this.requestedMode = input.requestedMode;
    this.currentStateToken = input.currentStateToken;
  }
}

export class ExistingRequestedDeliveryDateError extends Error {
  readonly requestedDeliveryDate: string;

  constructor(requestedDeliveryDate: string) {
    super("Voor deze bestelling is al een gewenste leverdatum geregistreerd.");
    this.name = "ExistingRequestedDeliveryDateError";
    this.requestedDeliveryDate = requestedDeliveryDate;
  }
}
