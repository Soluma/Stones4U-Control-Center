// Op rekening v1 — staging-only fault injection for the Phase H E2E
// (docs/ON-ACCOUNT-PAYMENT-DUE.md). Inert unless ALL of these hold:
//   - E2E_ON_ACCOUNT_FAULT names the fault point,
//   - E2E_ON_ACCOUNT_FAULT_ORDER is exactly the order being processed,
//   - the app is wired to the development shop only (SHOPIFY_SHOP_DOMAIN and
//     SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS are both exactly stones4u-dev).
// Production never has these variables and is never the dev shop.

export type OnAccountFaultPoint =
  | "invoice_send_outcome_unknown"
  | "crash_after_invoice_send"
  /** Phase I: PDF rendering throws (nothing stored, nothing sent). */
  | "invoice_pdf_render_fails"
  /** Phase I: Shopify returns no payment URL. */
  | "payment_link_unavailable"
  /** Phase I: the mail call times out before OfferteApp received it. */
  | "invoice_mail_timeout_before_send"
  /** Phase I: OfferteApp reports the SMTP hand-over as uncertain. */
  | "invoice_mail_uncertain";

const DEV_SHOP = "stones4u-dev.myshopify.com";

export class InjectedE2EFault extends Error {
  constructor(point: OnAccountFaultPoint) {
    super(`E2E injected fault: ${point}`);
    this.name = "InjectedE2EFault";
  }
}

export function e2eFaultActive(point: OnAccountFaultPoint, orderGid: string): boolean {
  if (process.env.SHOPIFY_SHOP_DOMAIN?.trim() !== DEV_SHOP) return false;
  if (process.env.SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS?.trim() !== DEV_SHOP) return false;
  if (process.env.E2E_ON_ACCOUNT_FAULT?.trim() !== point) return false;
  return process.env.E2E_ON_ACCOUNT_FAULT_ORDER?.trim() === orderGid;
}
