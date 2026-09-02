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
