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
};

export type CustomerOrdersResult = {
  orders: ShopifyOrderSummary[];
  totalOrders: number;
  totalSpent: { amount: string; currencyCode: string } | null;
  outstandingOrders: number;
  lastOrderAt: string | null;
};
