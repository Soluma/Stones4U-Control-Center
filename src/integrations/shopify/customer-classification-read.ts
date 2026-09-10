import "server-only";
import { shopifyGraphQL } from "./client";
import {
  CUSTOMER_CLASSIFICATION_NAMESPACE,
  CUSTOMER_TYPE_METAFIELD_KEY,
  PAYMENT_POLICY_METAFIELD_KEY,
  customerTypeOrUnknown,
  paymentPolicyOrUnknown,
  readCustomerType,
  readPaymentPolicy,
  unclassifiedCustomer,
  type CustomerClassification,
} from "./customer-classification";

// Phase 6W — reads the two Stones4U classification metafields off a Shopify
// Customer.
//
// EXACT-KEY READS, NOT ENUMERATION (build instruction §4). Both fields are
// addressed by their exact namespace/key through the singular `metafield`
// field. Enumerating a customer's metafields would pull unrelated data this
// feature has no business seeing, cost more of the query budget, and expose a
// duplicate-key case that this access pattern cannot actually produce.
//
// NO CUSTOMER MUTATION. This module reads; it never writes. Nothing here
// creates a metafield definition, sets a value, or touches a customer record.
//
// NO PII. The query asks for the two classification values and nothing else —
// no name, email, phone, address, or order history. The customer GID is
// already known to the caller.

const CUSTOMER_CLASSIFICATION_QUERY = /* GraphQL */ `
  query CustomerClassification($id: ID!, $namespace: String!, $paymentPolicyKey: String!, $customerTypeKey: String!) {
    customer(id: $id) {
      id
      paymentPolicy: metafield(namespace: $namespace, key: $paymentPolicyKey) {
        value
      }
      customerType: metafield(namespace: $namespace, key: $customerTypeKey) {
        value
      }
    }
  }
`;

type RawCustomerClassification = {
  customer: {
    id: string;
    paymentPolicy: { value: string | null } | null;
    customerType: { value: string | null } | null;
  } | null;
};

/**
 * Reads and parses a customer's classification. **Never throws** — every
 * failure path collapses to the fail-closed `UNKNOWN`/`UNREADABLE` result
 * (build instruction §6).
 *
 * The swallow-and-fail-closed behaviour is deliberate, and is the reason this
 * is a separate query rather than extra fields on the Order query it is
 * called alongside. A missing scope, a throttle, or a network blip while
 * reading a *classification* must never break reading the *Order* itself —
 * that would turn a conservative "we don't know enough to ask" into a broken
 * staff-facing handoff feature. Failing closed here costs nothing: UNKNOWN
 * already means "no automatic delivery request".
 *
 * It also never falls back to PREPAID, and never consults the Order to guess
 * — an unreadable classification is recorded as unreadable.
 */
export async function readCustomerClassification(customerGid: string | null): Promise<CustomerClassification> {
  // Build instruction §5 — an Order with no customer is UNKNOWN on both axes.
  // No classification is fabricated, and no automatic delivery request can
  // follow from it.
  if (!customerGid) return unclassifiedCustomer("NO_CUSTOMER");

  let data: RawCustomerClassification;
  try {
    data = await shopifyGraphQL<RawCustomerClassification>(CUSTOMER_CLASSIFICATION_QUERY, {
      id: customerGid,
      namespace: CUSTOMER_CLASSIFICATION_NAMESPACE,
      paymentPolicyKey: PAYMENT_POLICY_METAFIELD_KEY,
      customerTypeKey: CUSTOMER_TYPE_METAFIELD_KEY,
    });
  } catch (error) {
    // Logged without the customer GID or any response body — an operational
    // signal only.
    console.error(
      "customer_classification_read_failed",
      error instanceof Error ? error.name : "UNKNOWN_ERROR",
    );
    return unclassifiedCustomer("UNREADABLE");
  }

  // A customer GID that no longer resolves is not an error condition worth
  // throwing over, but it is emphatically not a classification either.
  //
  // Optional-chained deliberately: a caller-supplied transport (or a test
  // double) that answers with an unexpected shape must degrade to the same
  // fail-closed UNKNOWN as any other unreadable result, never throw past this
  // function. "Never throws" is the contract this module advertises, and a
  // TypeError here would break the Order read it is called alongside.
  if (!data?.customer) return unclassifiedCustomer("UNREADABLE");

  const paymentPolicyRead = readPaymentPolicy(data.customer.paymentPolicy?.value);
  const customerTypeRead = readCustomerType(data.customer.customerType?.value);

  return {
    paymentPolicy: paymentPolicyOrUnknown(paymentPolicyRead),
    customerType: customerTypeOrUnknown(customerTypeRead),
    source: "CUSTOMER_METAFIELDS",
    paymentPolicyStatus: paymentPolicyRead.status,
    customerTypeStatus: customerTypeRead.status,
  };
}
