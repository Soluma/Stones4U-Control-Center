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
export class ExistingRequestedDeliveryDateError extends Error {
  readonly requestedDeliveryDate: string;

  constructor(requestedDeliveryDate: string) {
    super("Voor deze bestelling is al een gewenste leverdatum geregistreerd.");
    this.name = "ExistingRequestedDeliveryDateError";
    this.requestedDeliveryDate = requestedDeliveryDate;
  }
}
