import { describe, expect, it } from "vitest";
import { buildInvoiceSnapshot, formatEuro, InvoiceSnapshotError, toCents, type BuildSnapshotInput } from "@/modules/on-account/invoice/snapshot";
import { renderInvoicePdf } from "@/modules/on-account/invoice/render";
import { buildInvoiceMail, isAcceptablePaymentUrl } from "@/modules/on-account/invoice/mail";

// Op rekening v1, Phase I — the definitive invoice is built ONLY from the
// Shopify Order's own amounts and refuses to exist when they do not add up.

const m = (amount: string) => ({ shopMoney: { amount } });
const tax = (rate: number, amount: string) => ({ title: "NL btw", rate: rate / 100, ratePercentage: rate, priceSet: m(amount) });
const COMPANY = {
  name: "Stones4U",
  address: "Voorbeeldstraat 1",
  postcode: "4000 AA",
  city: "Tiel",
  phone: null,
  email: "info@stones4u.eu",
  website: null,
  kvk: "12345678",
  vatNumber: "NL001234567B01",
  iban: "NL00BANK0123456789",
  logo: null,
};
const ADDRESS = { company: "Klant B.V.", name: "Jan Klant", firstName: "Jan", lastName: "Klant", address1: "Industrieweg 12", address2: null, zip: "4000 AB", city: "Tiel", country: "Netherlands", countryCodeV2: "NL" };

function order(over: Record<string, unknown> = {}) {
  return {
    id: "gid://shopify/Order/1",
    name: "#1842",
    legacyResourceId: "1",
    createdAt: "2026-10-20T09:00:00Z",
    cancelledAt: null,
    displayFinancialStatus: "PENDING",
    currencyCode: "EUR",
    taxesIncluded: true,
    email: "klant@example.com",
    billingAddress: ADDRESS,
    shippingAddress: null,
    customer: { displayName: "Jan Klant", email: "klant@example.com", defaultAddress: null, vatNumber: null },
    purchasingEntity: { __typename: "Customer" },
    lineItems: {
      nodes: [
        { id: "l1", title: "Opsluitband", variantTitle: null, sku: "120103", quantity: 40, currentQuantity: 40, originalUnitPriceSet: m("3.69"), originalTotalSet: m("147.60"), discountAllocations: [{ allocatedAmountSet: m("14.76") }], taxLines: [tax(21, "23.05")] },
        { id: "l2", title: "Brochure", variantTitle: null, sku: null, quantity: 1, currentQuantity: 1, originalUnitPriceSet: m("10.90"), originalTotalSet: m("10.90"), discountAllocations: [], taxLines: [tax(9, "0.90")] },
      ],
    },
    shippingLines: { nodes: [{ title: "Transport euro pallet", originalPriceSet: m("95.00"), discountedPriceSet: m("95.00"), taxLines: [tax(21, "16.49")] }] },
    subtotalPriceSet: m("143.74"),
    currentSubtotalPriceSet: m("143.74"),
    totalDiscountsSet: m("14.76"),
    totalShippingPriceSet: m("95.00"),
    totalTaxSet: m("40.44"),
    currentTotalTaxSet: m("40.44"),
    totalPriceSet: m("238.74"),
    currentTotalPriceSet: m("238.74"),
    totalOutstandingSet: m("238.74"),
    taxLines: [tax(21, "39.54"), tax(9, "0.90")],
    paymentTerms: { paymentTermsType: "FIXED", paymentSchedules: { nodes: [{ dueAt: "2026-11-20T22:59:59Z" }] } },
    ...over,
  } as unknown as BuildSnapshotInput["order"];
}
const input = (over: Partial<BuildSnapshotInput> = {}): BuildSnapshotInput => ({
  order: order(),
  company: COMPANY,
  termDays: 30,
  deliveredAt: new Date("2026-10-21T07:00:00Z"),
  dueAt: new Date("2026-11-20T22:59:59Z"),
  issuedAt: new Date("2026-10-21T07:05:00Z"),
  ...over,
});
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof InvoiceSnapshotError ? e.reason : `other: ${String(e)}`;
  }
  return "no error";
};

describe("money and dates", () => {
  it("parses Shopify decimal strings exactly (no floats)", () => {
    expect(toCents("24.2")).toBe(2420);
    expect(toCents("0.1")).toBe(10);
    expect(toCents("1234.56")).toBe(123456);
    expect(toCents("7.00")).toBe(700);
    expect(toCents("-0.01")).toBe(-1);
    expect(reason(() => toCents("1.005"))).toBe("INVOICE_AMOUNTS_INCONSISTENT");
    expect(formatEuro(123456)).toBe("€ 1.234,56");
    expect(formatEuro(5)).toBe("€ 0,05");
  });
});

describe("buildInvoiceSnapshot", () => {
  it("invoice number = order number; per-rate VAT; totals equal Shopify's exactly", () => {
    const s = buildInvoiceSnapshot(input());
    expect(s.invoiceNumber).toBe("1842");
    expect(s.shopifyOrderName).toBe("#1842");
    expect(s.invoiceDate).toBe("2026-10-21");
    expect(s.deliveryDate).toBe("2026-10-21");
    expect(s.dueDate).toBe("2026-11-20");
    expect(s.totals).toEqual({ discountCents: 1476, shippingCents: 9500, subtotalExclCents: 19830, vatCents: 4044, totalCents: 23874, outstandingCents: 23874 });
    expect(s.vatSummary).toEqual([
      { ratePercentage: 21, baseExclCents: 18830, vatCents: 3954 },
      { ratePercentage: 9, baseExclCents: 1000, vatCents: 90 },
    ]);
    expect(s.lines[0]).toMatchObject({ quantity: 40, grossCents: 14760, discountCents: 1476, netCents: 13284, vatCents: 2305, netExclCents: 10979, unitPriceExclCents: 305 });
    expect(s.shipping[0]).toMatchObject({ title: "Transport euro pallet", netCents: 9500, vatCents: 1649, netExclCents: 7851 });
    expect(s.customer).toMatchObject({ company: "Klant B.V.", name: "Jan Klant", addressLines: ["Industrieweg 12", "4000 AB  Tiel"], vatNumber: null });
    expect(s.supplier).toMatchObject({ kvk: "12345678", vatNumber: "NL001234567B01", iban: "NL00BANK0123456789" });
  });

  it("delivery date and due date are Amsterdam calendar dates (DST-correct)", () => {
    const s = buildInvoiceSnapshot(input({ deliveredAt: new Date("2026-10-24T22:30:00Z") })); // 25-10 00:30 CEST
    expect(s.deliveryDate).toBe("2026-10-25");
  });

  it("refuses when the lines do not add up to Shopify's total or tax", () => {
    expect(reason(() => buildInvoiceSnapshot(input({ order: order({ totalPriceSet: m("238.75"), currentTotalPriceSet: m("238.75") }) })))).toBe("INVOICE_AMOUNTS_INCONSISTENT");
    expect(reason(() => buildInvoiceSnapshot(input({ order: order({ totalTaxSet: m("40.45") }) })))).toBe("INVOICE_AMOUNTS_INCONSISTENT");
  });

  it("refuses an order that was edited/refunded after the sale", () => {
    expect(reason(() => buildInvoiceSnapshot(input({ order: order({ currentTotalPriceSet: m("100.00") }) })))).toBe("INVOICE_ORDER_CHANGED");
  });

  it("refuses when the FIXED due date on Shopify is not ours", () => {
    expect(reason(() => buildInvoiceSnapshot(input({ dueAt: new Date("2026-11-21T22:59:59Z") })))).toBe("DUE_DATE_CONFLICT");
  });

  it("refuses incomplete Stones4U details (KvK/btw/IBAN/address are mandatory)", () => {
    for (const key of ["kvk", "vatNumber", "iban", "address"] as const) {
      expect(reason(() => buildInvoiceSnapshot(input({ company: { ...COMPANY, [key]: null } })))).toBe("COMPANY_PROFILE_INCOMPLETE");
    }
  });

  it("invoice address: billing address, else the customer's default address, else the shipping address, else refuse", () => {
    const viaShipping = buildInvoiceSnapshot(
      input({ order: order({ billingAddress: null, shippingAddress: { ...ADDRESS, address1: "Afleverweg 3" }, customer: { displayName: "Jan", email: null, defaultAddress: null, vatNumber: null } }) }),
    );
    expect(viaShipping.customer.addressLines[0]).toBe("Afleverweg 3");
    const fallback = buildInvoiceSnapshot(input({ order: order({ billingAddress: null, customer: { displayName: "Jan", email: "k@e.nl", defaultAddress: ADDRESS, vatNumber: null } }) }));
    expect(fallback.customer.addressLines[0]).toBe("Industrieweg 12");
    expect(reason(() => buildInvoiceSnapshot(input({ order: order({ billingAddress: null, customer: { displayName: "Jan", email: null, defaultAddress: null, vatNumber: null } }) })))).toBe(
      "INVOICE_ADDRESS_MISSING",
    );
  });

  it("customer VAT number from a B2B company location or the customer metafield", () => {
    const b2b = buildInvoiceSnapshot(
      input({ order: order({ purchasingEntity: { __typename: "PurchasingCompany", company: { name: "Klant B.V." }, location: { taxSettings: { taxRegistrationId: "NL999999999B01" } } } }) }),
    );
    expect(b2b.customer.vatNumber).toBe("NL999999999B01");
    const meta = buildInvoiceSnapshot(input({ order: order({ customer: { displayName: "Jan", email: null, defaultAddress: null, vatNumber: { value: "BE0123456789" } } }) }));
    expect(meta.customer.vatNumber).toBe("BE0123456789");
  });
});

describe("renderInvoicePdf", () => {
  it("produces a PDF, byte-for-byte the same for the same snapshot", async () => {
    const s = buildInvoiceSnapshot(input());
    const a = await renderInvoicePdf({ snapshot: s, logo: null });
    const b = await renderInvoicePdf({ snapshot: s, logo: null });
    expect(a.subarray(0, 5).toString()).toBe("%PDF-");
    expect(a.length).toBeGreaterThan(1000);
    expect(a.equals(b)).toBe(true);
  });

  it("an unusable logo never breaks the invoice", async () => {
    const s = buildInvoiceSnapshot(input());
    const pdf = await renderInvoicePdf({ snapshot: s, logo: { mime: "image/png", base64: "bm90LWEtcG5n" } });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("invoice mail", () => {
  it("subject, filename, facts and the payment button come from the snapshot; values are HTML-escaped", () => {
    const s = buildInvoiceSnapshot(input({ order: order({ billingAddress: { ...ADDRESS, name: '<script>alert("x")</script>' } }) }));
    const mail = buildInvoiceMail(s, "https://stones4u-dev.myshopify.com/1/order_payment/1?secret=abc&x=1");
    expect(mail.subject).toBe("Factuur Stones4U 1842");
    expect(mail.filename).toBe("Factuur_1842.pdf");
    expect(mail.html).toContain("FACTUUR BETALEN");
    expect(mail.html).toContain('href="https://stones4u-dev.myshopify.com/1/order_payment/1?secret=abc&amp;x=1"');
    expect(mail.html).not.toContain("<script>");
    expect(mail.text).toContain("Factuurnummer: 1842");
    expect(mail.text).toContain("Vervaldatum: 20-11-2026");
    expect(mail.text).toContain("Te betalen: € 238,74");
  });

  it("only Shopify's https order_payment link of THIS order on an allowed host is acceptable", () => {
    const ok = "https://stones4u-dev.myshopify.com/98120958297/order_payment/13460567982425?secret=x";
    expect(isAcceptablePaymentUrl(ok, "stones4u-dev.myshopify.com", "13460567982425")).toBe(true);
    expect(isAcceptablePaymentUrl(ok, "stones4u-dev.myshopify.com", "1")).toBe(false);
    expect(isAcceptablePaymentUrl(ok, "evil.example", "13460567982425")).toBe(false);
    expect(isAcceptablePaymentUrl(ok.replace("https:", "http:"), "stones4u-dev.myshopify.com", "13460567982425")).toBe(false);
    expect(isAcceptablePaymentUrl("https://stones4u-dev.myshopify.com/98120958297/orders/13460567982425", "stones4u-dev.myshopify.com", "13460567982425")).toBe(false);
    expect(isAcceptablePaymentUrl("not a url", "stones4u-dev.myshopify.com", "1")).toBe(false);
  });
});
