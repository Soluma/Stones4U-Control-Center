export type ShopifyGraphQLUserError = { message: string; extensions?: unknown };

export class ShopifyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyConfigError";
  }
}

export class ShopifyApiError extends Error {
  readonly status?: number;
  readonly graphqlErrors?: ShopifyGraphQLUserError[];

  constructor(message: string, options?: { status?: number; graphqlErrors?: ShopifyGraphQLUserError[] }) {
    super(message);
    this.name = "ShopifyApiError";
    this.status = options?.status;
    this.graphqlErrors = options?.graphqlErrors;
  }
}

export class ShopifyShopIdentityMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`Shopify shop identity mismatch: expected "${expected}", got "${actual}"`);
    this.name = "ShopifyShopIdentityMismatchError";
  }
}

// Phase 6D — a distinct type from the generic ShopifyApiError so callers
// (submitRequestedDeliveryDateForOrder) can tell "this Order is cancelled,
// resubmitting will never help" apart from a genuinely transient failure,
// without resorting to fragile message-string matching.
export class OrderCancelledError extends Error {
  constructor(orderGid: string) {
    super(`Order ${orderGid} is geannuleerd — geen leverdatum-mirror mogelijk.`);
    this.name = "OrderCancelledError";
  }
}
