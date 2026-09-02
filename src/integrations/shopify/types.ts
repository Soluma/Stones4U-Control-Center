export type ShopifyCustomerSummary = {
  gid: string;
  legacyId: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  defaultAddressSummary: string | null;
  numberOfOrders: number;
  amountSpent: { amount: string; currencyCode: string } | null;
};

export type ShopifyOrderSummary = {
  gid: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  currentTotalPriceSet: { amount: string; currencyCode: string };
  lineItemCount: number;
  /** Phase 3a — docs/platform-discovery/29-PHASE-3-BUILD-SPEC.md §3 */
  adminUrl: string;
};

export type CustomerOrdersResult = {
  orders: ShopifyOrderSummary[];
  totalOrders: number;
  totalSpent: { amount: string; currencyCode: string } | null;
  outstandingOrders: number;
  lastOrderAt: string | null;
};

// Phase 3a — docs/platform-discovery/29-PHASE-3-BUILD-SPEC.md §9
export type ShopifyDraftOrderSummary = {
  gid: string;
  name: string;
  /** Shopify's DraftOrderStatus: OPEN | INVOICE_SENT | COMPLETED */
  status: string;
  createdAt: string;
  updatedAt: string;
  totalPriceSet: { amount: string; currencyCode: string };
  invoiceUrl: string | null;
  /** Set once the draft order has been converted to a real order. */
  completedOrder: { gid: string; name: string; adminUrl: string } | null;
  adminUrl: string;
};

export type CustomerDraftOrdersResult = {
  draftOrders: ShopifyDraftOrderSummary[];
};
