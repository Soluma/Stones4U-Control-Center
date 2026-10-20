import "server-only";
import { shopifyGraphQL } from "./client";
import { ShopifyApiError } from "./errors";

// Op rekening v1 — READ side for the payment-due service (no mutations in
// this file; the guarded writes live in ./on-account.ts). Raw Shopify data
// only; every decision lives in modules/on-account.

export const STONES4U_NAMESPACE = "stones4u";
export const ORDER_TERM_DAYS_KEY = "payment_term_days";
export const ORDER_HANDED_OVER_AT_KEY = "handed_over_at";
export const ORDER_INVOICE_SENT_AT_KEY = "invoice_sent_at";
export const CUSTOMER_CREDIT_ALLOWED_KEY = "credit_allowed";
export const CUSTOMER_TERM_DAYS_KEY = "payment_term_days";
/** Custom attributes written atomically on the draft by POS/OfferteApp. */
export const ATTR_TERM_DAYS = "_stones4u_payment_term_days";
export const ATTR_HANDED_OVER_AT = "_stones4u_handed_over_at";

export type OnAccountPaymentTerms = {
  id: string;
  type: string;
  name: string | null;
  overdue: boolean;
  schedules: { id: string; dueAt: string | null; completedAt: string | null }[];
};

export type OnAccountOrderSnapshot = {
  id: string;
  name: string;
  createdAt: string;
  tags: string[];
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  total: string;
  outstanding: string;
  email: string | null;
  customerId: string | null;
  customerEmail: string | null;
  appName: string | null;
  paymentTerms: OnAccountPaymentTerms | null;
  metafields: { termDays: string | null; handedOverAt: string | null; invoiceSentAt: string | null };
  attributes: { termDays: string | null; handedOverAt: string | null };
  /** "sent invoice" timeline events (newest first) — used only to resolve an uncertain send. */
  invoiceEvents: { createdAt: string; message: string }[];
};

const ORDER_QUERY = /* GraphQL */ `
  query OnAccountOrder($id: ID!, $ns: String!, $termKey: String!, $handedKey: String!, $sentKey: String!) {
    order(id: $id) {
      id
      name
      createdAt
      tags
      cancelledAt
      displayFinancialStatus
      displayFulfillmentStatus
      email
      app { name }
      customer { id defaultEmailAddress { emailAddress } }
      totalPriceSet { shopMoney { amount } }
      totalOutstandingSet { shopMoney { amount } }
      customAttributes { key value }
      termDays: metafield(namespace: $ns, key: $termKey) { value }
      handedOverAt: metafield(namespace: $ns, key: $handedKey) { value }
      invoiceSentAt: metafield(namespace: $ns, key: $sentKey) { value }
      paymentTerms {
        id
        paymentTermsType
        paymentTermsName
        overdue
        paymentSchedules(first: 5) { nodes { id dueAt completedAt } }
      }
      events(first: 50, sortKey: CREATED_AT, reverse: true) { nodes { createdAt message } }
    }
  }
`;

type OrderQueryResponse = {
  order: {
    id: string;
    name: string;
    createdAt: string;
    tags: string[];
    cancelledAt: string | null;
    displayFinancialStatus: string | null;
    displayFulfillmentStatus: string | null;
    email: string | null;
    app: { name: string } | null;
    customer: { id: string; defaultEmailAddress: { emailAddress: string } | null } | null;
    totalPriceSet: { shopMoney: { amount: string } };
    totalOutstandingSet: { shopMoney: { amount: string } };
    customAttributes: { key: string; value: string | null }[];
    termDays: { value: string } | null;
    handedOverAt: { value: string } | null;
    invoiceSentAt: { value: string } | null;
    paymentTerms: {
      id: string;
      paymentTermsType: string;
      paymentTermsName: string | null;
      overdue: boolean;
      paymentSchedules: { nodes: { id: string; dueAt: string | null; completedAt: string | null }[] };
    } | null;
    events: { nodes: { createdAt: string; message: string }[] };
  } | null;
};

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "").trim();
}

export async function readOnAccountOrder(orderGid: string): Promise<OnAccountOrderSnapshot | null> {
  const data = await shopifyGraphQL<OrderQueryResponse>(ORDER_QUERY, {
    id: orderGid,
    ns: STONES4U_NAMESPACE,
    termKey: ORDER_TERM_DAYS_KEY,
    handedKey: ORDER_HANDED_OVER_AT_KEY,
    sentKey: ORDER_INVOICE_SENT_AT_KEY,
  });
  const o = data.order;
  if (!o) return null;
  const attr = (key: string) => o.customAttributes.find((a) => a.key === key)?.value ?? null;
  return {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    tags: o.tags,
    cancelledAt: o.cancelledAt,
    displayFinancialStatus: o.displayFinancialStatus,
    displayFulfillmentStatus: o.displayFulfillmentStatus,
    total: o.totalPriceSet.shopMoney.amount,
    outstanding: o.totalOutstandingSet.shopMoney.amount,
    email: o.email,
    customerId: o.customer?.id ?? null,
    customerEmail: o.customer?.defaultEmailAddress?.emailAddress ?? null,
    appName: o.app?.name ?? null,
    paymentTerms: o.paymentTerms
      ? {
          id: o.paymentTerms.id,
          type: o.paymentTerms.paymentTermsType,
          name: o.paymentTerms.paymentTermsName,
          overdue: o.paymentTerms.overdue,
          schedules: o.paymentTerms.paymentSchedules.nodes,
        }
      : null,
    metafields: {
      termDays: o.termDays?.value ?? null,
      handedOverAt: o.handedOverAt?.value ?? null,
      invoiceSentAt: o.invoiceSentAt?.value ?? null,
    },
    attributes: { termDays: attr(ATTR_TERM_DAYS), handedOverAt: attr(ATTR_HANDED_OVER_AT) },
    invoiceEvents: o.events.nodes
      .map((e) => ({ createdAt: e.createdAt, message: stripHtml(e.message) }))
      .filter((e) => /sent invoice/i.test(e.message)),
  };
}


const FIXED_TEMPLATE_QUERY = /* GraphQL */ `
  query FixedPaymentTermsTemplate {
    paymentTermsTemplates(paymentTermsType: FIXED) { id paymentTermsType }
  }
`;
let fixedTemplateId: string | null = null;

export async function getFixedTemplateId(): Promise<string> {
  if (fixedTemplateId) return fixedTemplateId;
  const data = await shopifyGraphQL<{ paymentTermsTemplates: { id: string; paymentTermsType: string }[] }>(FIXED_TEMPLATE_QUERY);
  const template = data.paymentTermsTemplates.find((t) => t.paymentTermsType === "FIXED");
  if (!template) throw new ShopifyApiError("Geen FIXED-betaaltermijnsjabloon gevonden in Shopify.");
  fixedTemplateId = template.id;
  return template.id;
}

export function __resetOnAccountTemplateCacheForTests(): void {
  fixedTemplateId = null;
}


export type CustomerCreditRaw = {
  customerId: string;
  displayName: string | null;
  email: string | null;
  creditAllowed: string | null;
  termDays: string | null;
};

export async function readCustomerCreditRaw(customerGid: string): Promise<CustomerCreditRaw | null> {
  const data = await shopifyGraphQL<{
    customer: {
      id: string;
      displayName: string | null;
      defaultEmailAddress: { emailAddress: string } | null;
      creditAllowed: { value: string } | null;
      termDays: { value: string } | null;
    } | null;
  }>(
    /* GraphQL */ `
      query OnAccountCustomerCredit($id: ID!, $ns: String!, $creditKey: String!, $termKey: String!) {
        customer(id: $id) {
          id
          displayName
          defaultEmailAddress { emailAddress }
          creditAllowed: metafield(namespace: $ns, key: $creditKey) { value }
          termDays: metafield(namespace: $ns, key: $termKey) { value }
        }
      }
    `,
    { id: customerGid, ns: STONES4U_NAMESPACE, creditKey: CUSTOMER_CREDIT_ALLOWED_KEY, termKey: CUSTOMER_TERM_DAYS_KEY },
  );
  const c = data.customer;
  if (!c) return null;
  return {
    customerId: c.id,
    displayName: c.displayName,
    email: c.defaultEmailAddress?.emailAddress ?? null,
    creditAllowed: c.creditAllowed?.value ?? null,
    termDays: c.termDays?.value ?? null,
  };
}

