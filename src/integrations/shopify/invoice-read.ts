import "server-only";
import { shopifyGraphQL } from "./client";

// Op rekening v1, Phase I — READ side for the definitive invoice (queries
// only; no mutation helpers here). The Shopify Order is the financial source
// of truth: every amount on the invoice comes from this read of the EXACT
// order GID, taken right before the invoice is built. Raw data only; every
// decision lives in modules/on-account/invoice.

type Money = { shopMoney: { amount: string } };
export type InvoiceTaxLineRaw = { title: string; rate: number | null; ratePercentage: number | null; priceSet: Money };
export type InvoiceAddressRaw = {
  company: string | null;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  address1: string | null;
  address2: string | null;
  zip: string | null;
  city: string | null;
  country: string | null;
  countryCodeV2: string | null;
} | null;

export type InvoiceOrderRaw = {
  id: string;
  name: string;
  legacyResourceId: string;
  createdAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  currencyCode: string;
  taxesIncluded: boolean;
  email: string | null;
  billingAddress: InvoiceAddressRaw;
  shippingAddress: InvoiceAddressRaw;
  customer: {
    displayName: string | null;
    email: string | null;
    defaultAddress: InvoiceAddressRaw;
    vatNumber: { value: string } | null;
  } | null;
  purchasingEntity:
    | { __typename: "PurchasingCompany"; company: { name: string } | null; location: { taxSettings: { taxRegistrationId: string | null } | null } | null }
    | { __typename: string };
  lineItems: {
    nodes: {
      id: string;
      title: string;
      variantTitle: string | null;
      sku: string | null;
      quantity: number;
      currentQuantity: number;
      originalUnitPriceSet: Money;
      originalTotalSet: Money;
      discountAllocations: { allocatedAmountSet: Money }[];
      taxLines: InvoiceTaxLineRaw[];
    }[];
  };
  shippingLines: {
    nodes: { title: string; originalPriceSet: Money; discountedPriceSet: Money; taxLines: InvoiceTaxLineRaw[] }[];
  };
  subtotalPriceSet: Money;
  currentSubtotalPriceSet: Money;
  totalDiscountsSet: Money;
  totalShippingPriceSet: Money;
  totalTaxSet: Money;
  currentTotalTaxSet: Money;
  totalPriceSet: Money;
  currentTotalPriceSet: Money;
  totalOutstandingSet: Money;
  taxLines: InvoiceTaxLineRaw[];
  paymentTerms: { paymentTermsType: string; paymentSchedules: { nodes: { dueAt: string | null }[] } } | null;
};

const ADDRESS = "company name firstName lastName address1 address2 zip city country countryCodeV2";
const TAX = "title rate ratePercentage priceSet { shopMoney { amount } }";
const MONEY = "shopMoney { amount }";

const INVOICE_ORDER_QUERY = `
  query OnAccountInvoiceOrder($id: ID!) {
    order(id: $id) {
      id name legacyResourceId createdAt cancelledAt displayFinancialStatus currencyCode taxesIncluded email
      billingAddress { ${ADDRESS} }
      shippingAddress { ${ADDRESS} }
      customer {
        displayName email
        defaultAddress { ${ADDRESS} }
        vatNumber: metafield(namespace: "stones4u", key: "vat_number") { value }
      }
      purchasingEntity {
        __typename
        ... on PurchasingCompany { company { name } location { taxSettings { taxRegistrationId } } }
      }
      lineItems(first: 250) {
        nodes {
          id title variantTitle sku quantity currentQuantity
          originalUnitPriceSet { ${MONEY} }
          originalTotalSet { ${MONEY} }
          discountAllocations { allocatedAmountSet { ${MONEY} } }
          taxLines { ${TAX} }
        }
      }
      shippingLines(first: 10) {
        nodes { title originalPriceSet { ${MONEY} } discountedPriceSet { ${MONEY} } taxLines { ${TAX} } }
      }
      subtotalPriceSet { ${MONEY} } currentSubtotalPriceSet { ${MONEY} }
      totalDiscountsSet { ${MONEY} }
      totalShippingPriceSet { ${MONEY} }
      totalTaxSet { ${MONEY} } currentTotalTaxSet { ${MONEY} }
      totalPriceSet { ${MONEY} } currentTotalPriceSet { ${MONEY} }
      totalOutstandingSet { ${MONEY} }
      taxLines { ${TAX} }
      paymentTerms { paymentTermsType paymentSchedules(first: 2) { nodes { dueAt } } }
    }
  }
`;

/** The exact order, fresh. null when Shopify does not know the GID. */
export async function readInvoiceOrder(orderGid: string): Promise<InvoiceOrderRaw | null> {
  const data = await shopifyGraphQL<{ order: InvoiceOrderRaw | null }>(INVOICE_ORDER_QUERY, { id: orderGid });
  return data.order;
}

export type PaymentLinkRead = {
  displayFinancialStatus: string | null;
  cancelledAt: string | null;
  outstanding: string;
  /** Shopify's own payment-collection URL — never constructed by us, never logged. */
  url: string | null;
};

const PAYMENT_LINK_QUERY = `
  query OnAccountPaymentLink($id: ID!) {
    order(id: $id) {
      displayFinancialStatus cancelledAt
      totalOutstandingSet { shopMoney { amount } }
      paymentCollectionDetails { additionalPaymentCollectionUrl }
    }
  }
`;

/** Read right before mailing: Shopify's documented payment URL for an existing order. */
export async function readPaymentLink(orderGid: string): Promise<PaymentLinkRead | null> {
  const data = await shopifyGraphQL<{
    order: {
      displayFinancialStatus: string | null;
      cancelledAt: string | null;
      totalOutstandingSet: Money;
      paymentCollectionDetails: { additionalPaymentCollectionUrl: string | null } | null;
    } | null;
  }>(PAYMENT_LINK_QUERY, { id: orderGid });
  if (!data.order) return null;
  return {
    displayFinancialStatus: data.order.displayFinancialStatus,
    cancelledAt: data.order.cancelledAt,
    outstanding: data.order.totalOutstandingSet.shopMoney.amount,
    url: data.order.paymentCollectionDetails?.additionalPaymentCollectionUrl ?? null,
  };
}
