import "server-only";

/** Master switch for the whole op-rekening service in this environment
 * (webhook recording, worker, integration API). Default OFF. Shopify writes
 * are additionally limited by SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS. */
export function isOnAccountServiceEnabled(): boolean {
  return process.env.ON_ACCOUNT_SERVICE_ENABLED === "true";
}

export const ON_ACCOUNT_WORKER_TOKEN_ENV = "ON_ACCOUNT_WORKER_TOKEN";
export const ON_ACCOUNT_SERVICE_TOKEN_ENV = "ON_ACCOUNT_SERVICE_TOKEN";
