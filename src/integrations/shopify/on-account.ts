import "server-only";
import { shopifyGraphQL } from "./client";
import { assertShopifyWriteAllowed } from "./write-safety-guard";
import {
  CUSTOMER_CREDIT_ALLOWED_KEY,
  CUSTOMER_TERM_DAYS_KEY,
  getFixedTemplateId,
  ORDER_INVOICE_SENT_AT_KEY,
  STONES4U_NAMESPACE,
} from "./on-account-read";

// Op rekening v1 — Shopify reads/writes for the central payment-due service
// (docs/ON-ACCOUNT-PAYMENT-DUE.md). Raw Shopify data only: every business
// decision (is this payable, which dueAt, may we send) lives in
// modules/on-account, never here (CLAUDE.md module boundaries).
//
// Behaviour verified on stones4u-dev (fase 0, 2026-10-20):
// - paymentTermsCreate on an order WITHOUT terms adds FIXED terms; a second
//   identical create REPLACES them (new ids) — Shopify is not idempotent, so
//   callers must read first and only write when something differs.
// - paymentTermsUpdate with the same dueAt still rewrites the schedule.
// - paymentTermsDelete on already-deleted terms: userError "Could not find
//   payment terms." (PAYMENT_TERMS_DELETE_UNSUCCESSFUL).
// - orderInvoiceSend sends again on every call (no dedupe, no state change);
//   on a paid order: userError "No outstanding balance exist".
// - Draft metafields do NOT carry over to the order; tags and custom
//   attributes DO.
//
// Every mutation below calls assertShopifyWriteAllowed() first, every time.
// Reads (order, customer credit, FIXED template) live in ./on-account-read.ts.


type UserError = { field: string[] | null; message: string; code: string | null };

export class ShopifyUserErrorsError extends Error {
  constructor(
    readonly operation: string,
    readonly userErrors: UserError[],
  ) {
    super(`${operation}: ${userErrors.map((e) => e.message).join("; ")}`);
  }
}

// ── payment terms ────────────────────────────────────────────────────

const TERMS_FIELDS = `id paymentTermsType paymentSchedules(first: 2) { nodes { id dueAt } }`;

export type DeleteTermsResult = { outcome: "DELETED" } | { outcome: "ALREADY_GONE" };

export async function deleteOrderPaymentTerms(paymentTermsId: string): Promise<DeleteTermsResult> {
  await assertShopifyWriteAllowed();
  const data = await shopifyGraphQL<{ paymentTermsDelete: { deletedId: string | null; userErrors: UserError[] } }>(
    /* GraphQL */ `
      mutation OnAccountDeleteTerms($input: PaymentTermsDeleteInput!) {
        paymentTermsDelete(input: $input) { deletedId userErrors { field message code } }
      }
    `,
    { input: { paymentTermsId } },
  );
  const { deletedId, userErrors } = data.paymentTermsDelete;
  if (deletedId) return { outcome: "DELETED" };
  if (userErrors.some((e) => /could not find payment terms/i.test(e.message))) return { outcome: "ALREADY_GONE" };
  throw new ShopifyUserErrorsError("paymentTermsDelete", userErrors);
}

export type FixedTermsResult = { paymentTermsId: string; dueAt: string | null };

export async function createFixedPaymentTerms(orderGid: string, dueAt: Date): Promise<FixedTermsResult> {
  await assertShopifyWriteAllowed();
  const templateId = await getFixedTemplateId();
  const data = await shopifyGraphQL<{
    paymentTermsCreate: { paymentTerms: { id: string; paymentSchedules: { nodes: { dueAt: string | null }[] } } | null; userErrors: UserError[] };
  }>(
    /* GraphQL */ `
      mutation OnAccountCreateFixedTerms($ref: ID!, $attrs: PaymentTermsCreateInput!) {
        paymentTermsCreate(referenceId: $ref, paymentTermsAttributes: $attrs) { paymentTerms { ${TERMS_FIELDS} } userErrors { field message code } }
      }
    `,
    { ref: orderGid, attrs: { paymentTermsTemplateId: templateId, paymentSchedules: [{ dueAt: dueAt.toISOString() }] } },
  );
  const { paymentTerms, userErrors } = data.paymentTermsCreate;
  if (!paymentTerms) throw new ShopifyUserErrorsError("paymentTermsCreate", userErrors);
  return { paymentTermsId: paymentTerms.id, dueAt: paymentTerms.paymentSchedules.nodes[0]?.dueAt ?? null };
}

export async function updateToFixedPaymentTerms(paymentTermsId: string, dueAt: Date): Promise<FixedTermsResult> {
  await assertShopifyWriteAllowed();
  const templateId = await getFixedTemplateId();
  const data = await shopifyGraphQL<{
    paymentTermsUpdate: { paymentTerms: { id: string; paymentSchedules: { nodes: { dueAt: string | null }[] } } | null; userErrors: UserError[] };
  }>(
    /* GraphQL */ `
      mutation OnAccountUpdateToFixedTerms($input: PaymentTermsUpdateInput!) {
        paymentTermsUpdate(input: $input) { paymentTerms { ${TERMS_FIELDS} } userErrors { field message code } }
      }
    `,
    { input: { paymentTermsId, paymentTermsAttributes: { paymentTermsTemplateId: templateId, paymentSchedules: [{ dueAt: dueAt.toISOString() }] } } },
  );
  const { paymentTerms, userErrors } = data.paymentTermsUpdate;
  if (!paymentTerms) throw new ShopifyUserErrorsError("paymentTermsUpdate", userErrors);
  return { paymentTermsId: paymentTerms.id, dueAt: paymentTerms.paymentSchedules.nodes[0]?.dueAt ?? null };
}

// ── invoice ──────────────────────────────────────────────────────────

/**
 * NOT_SENT means Shopify answered with userErrors (definitely no mail).
 * A thrown error (network/timeout/5xx) means the outcome is UNKNOWN — the
 * caller must treat that as "maybe sent" and never retry blindly.
 */
export type SendInvoiceResult = { outcome: "SENT" } | { outcome: "NOT_SENT"; userErrors: UserError[] };

export async function sendOrderInvoice(orderGid: string, to: string, customMessage: string): Promise<SendInvoiceResult> {
  await assertShopifyWriteAllowed();
  const data = await shopifyGraphQL<{ orderInvoiceSend: { order: { id: string } | null; userErrors: UserError[] } }>(
    /* GraphQL */ `
      mutation OnAccountSendInvoice($id: ID!, $email: EmailInput) {
        orderInvoiceSend(id: $id, email: $email) { order { id } userErrors { field message code } }
      }
    `,
    { id: orderGid, email: { to, customMessage } },
    // Never auto-retry: a timeout may mean the mail already went out.
    { retryUnknownOutcome: false },
  );
  const { order, userErrors } = data.orderInvoiceSend;
  if (order && userErrors.length === 0) return { outcome: "SENT" };
  return { outcome: "NOT_SENT", userErrors };
}

export async function setOrderInvoiceSentAt(orderGid: string, sentAt: Date): Promise<void> {
  await assertShopifyWriteAllowed();
  const data = await shopifyGraphQL<{ metafieldsSet: { userErrors: UserError[] } }>(
    /* GraphQL */ `
      mutation OnAccountSetInvoiceSentAt($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { metafields { key value } userErrors { field message code } }
      }
    `,
    {
      metafields: [
        { ownerId: orderGid, namespace: STONES4U_NAMESPACE, key: ORDER_INVOICE_SENT_AT_KEY, type: "date_time", value: sentAt.toISOString().replace(/\.\d{3}Z$/, "Z") },
      ],
    },
  );
  if (data.metafieldsSet.userErrors.length) throw new ShopifyUserErrorsError("metafieldsSet(invoice_sent_at)", data.metafieldsSet.userErrors);
}

// ── customer credit metafields ───────────────────────────────────────

/** termDays null = remove the stored term (the rule then defaults to 30). */
export async function writeCustomerCredit(customerGid: string, input: { creditAllowed: boolean; termDays: number | null }): Promise<void> {
  await assertShopifyWriteAllowed();
  const set: Record<string, string>[] = [
    { ownerId: customerGid, namespace: STONES4U_NAMESPACE, key: CUSTOMER_CREDIT_ALLOWED_KEY, type: "boolean", value: String(input.creditAllowed) },
  ];
  if (input.termDays !== null) {
    set.push({ ownerId: customerGid, namespace: STONES4U_NAMESPACE, key: CUSTOMER_TERM_DAYS_KEY, type: "number_integer", value: String(input.termDays) });
  }
  const data = await shopifyGraphQL<{ metafieldsSet: { userErrors: UserError[] } }>(
    /* GraphQL */ `
      mutation OnAccountSetCustomerCredit($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { metafields { key value } userErrors { field message code } }
      }
    `,
    { metafields: set },
  );
  if (data.metafieldsSet.userErrors.length) throw new ShopifyUserErrorsError("metafieldsSet(customer credit)", data.metafieldsSet.userErrors);
  if (input.termDays === null) {
    const del = await shopifyGraphQL<{ metafieldsDelete: { userErrors: { field: string[] | null; message: string }[] } }>(
      /* GraphQL */ `
        mutation OnAccountClearCustomerTerm($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) { deletedMetafields { key } userErrors { field message } }
        }
      `,
      { metafields: [{ ownerId: customerGid, namespace: STONES4U_NAMESPACE, key: CUSTOMER_TERM_DAYS_KEY }] },
    );
    if (del.metafieldsDelete.userErrors.length) {
      throw new ShopifyUserErrorsError("metafieldsDelete(customer term)", del.metafieldsDelete.userErrors.map((e) => ({ ...e, code: null })));
    }
  }
}
