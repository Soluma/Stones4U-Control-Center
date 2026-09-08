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
