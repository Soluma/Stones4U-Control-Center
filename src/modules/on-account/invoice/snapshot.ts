// Op rekening v1, Phase I — the definitive invoice's financial snapshot
// (pure, no I/O). Built from a FRESH read of the exact Shopify Order: every
// amount is Shopify's own, in integer cents, and the snapshot refuses to
// exist when those amounts do not add up exactly. Invoice number = the
// Shopify order number (decision 2026-10-21). Once stored, a snapshot is
// never rebuilt for the same order (see invoice.service.ts).
import { createHash } from "crypto";
import type { InvoiceAddressRaw, InvoiceOrderRaw, InvoiceTaxLineRaw } from "@/integrations/shopify/invoice-read";
import type { CompanyProfile } from "@/integrations/offerteapp/invoice-mail";
import type { ReviewReason } from "../state-machine";

export const SNAPSHOT_VERSION = 1;

export class InvoiceSnapshotError extends Error {
  constructor(
    readonly reason: ReviewReason,
    message: string,
  ) {
    super(message);
  }
}

/** "24.2" -> 2420, "-0.01" -> -1. Exact for Shopify's decimal strings (no floats). */
export function toCents(amount: string): number {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new InvoiceSnapshotError("INVOICE_AMOUNTS_INCONSISTENT", `ongeldig bedrag "${amount}"`);
  const frac = (m[3] ?? "").padEnd(2, "0");
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) {
    throw new InvoiceSnapshotError("INVOICE_AMOUNTS_INCONSISTENT", `bedrag met meer dan 2 decimalen "${amount}"`);
  }
  const cents = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  return m[1] ? -cents : cents;
}

/** Calendar date in Europe/Amsterdam, "YYYY-MM-DD". */
export function amsterdamDate(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

export type InvoiceParty = {
  company: string | null;
  name: string | null;
  addressLines: string[];
  country: string | null;
  vatNumber: string | null;
  email: string | null;
};

export type InvoiceLine = {
  title: string;
  sku: string | null;
  quantity: number;
  /** Unit price as Shopify shows it (incl. VAT when taxesIncluded). */
  unitPriceCents: number;
  /** Unit price excl. VAT (art. 35a Wet OB). Derived for display only from
   * Shopify's unit price and rate; every total stays Shopify's own amount. */
  unitPriceExclCents: number;
  grossCents: number;
  discountCents: number;
  /** After discounts, incl. VAT when taxesIncluded. */
  netCents: number;
  vatRatePercentage: number;
  vatCents: number;
  netExclCents: number;
};

export type InvoiceSnapshot = {
  version: number;
  invoiceNumber: string;
  shopifyOrderName: string;
  shopifyOrderGid: string;
  orderDate: string;
  invoiceDate: string;
  deliveryDate: string;
  deliveredAt: string;
  termDays: number;
  dueAt: string;
  dueDate: string;
  currency: string;
  taxesIncluded: boolean;
  supplier: {
    name: string;
    address: string;
    postcode: string;
    city: string;
    phone: string | null;
    email: string | null;
    website: string | null;
    kvk: string;
    vatNumber: string;
    iban: string;
    logoSha256: string | null;
  };
  customer: InvoiceParty;
  lines: InvoiceLine[];
  shipping: InvoiceLine[];
  vatSummary: { ratePercentage: number; baseExclCents: number; vatCents: number }[];
  totals: {
    discountCents: number;
    shippingCents: number;
    subtotalExclCents: number;
    vatCents: number;
    totalCents: number;
    outstandingCents: number;
  };
};

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const exclOf = (cents: number, ratePercentage: number, taxesIncluded: boolean) =>
  taxesIncluded && ratePercentage > 0 ? Math.round((cents * 100) / (100 + ratePercentage)) : cents;

function onlyTax(lines: InvoiceTaxLineRaw[], what: string): { ratePercentage: number; vatCents: number } {
  if (lines.length > 1) throw new InvoiceSnapshotError("INVOICE_AMOUNTS_INCONSISTENT", `${what} heeft meer dan één btw-regel`);
  const line = lines[0];
  if (!line) return { ratePercentage: 0, vatCents: 0 };
  const rate = line.ratePercentage ?? (line.rate !== null ? Math.round(line.rate * 10000) / 100 : null);
  if (rate === null) throw new InvoiceSnapshotError("INVOICE_AMOUNTS_INCONSISTENT", `${what} heeft geen btw-tarief`);
  return { ratePercentage: rate, vatCents: toCents(line.priceSet.shopMoney.amount) };
}

function party(address: InvoiceAddressRaw, fallbackName: string | null, vatNumber: string | null, email: string | null): InvoiceParty | null {
  if (!address?.address1?.trim() || !address.city?.trim()) return null;
  const name = address.name?.trim() || [address.firstName, address.lastName].filter(Boolean).join(" ").trim() || fallbackName;
  const lines = [address.address1.trim(), address.address2?.trim(), [address.zip?.trim(), address.city.trim()].filter(Boolean).join("  ")].filter(
    (l): l is string => !!l,
  );
  return { company: address.company?.trim() || null, name: name || null, addressLines: lines, country: address.country ?? null, vatNumber, email };
}

export type BuildSnapshotInput = {
  order: InvoiceOrderRaw;
  company: CompanyProfile;
  termDays: number;
  deliveredAt: Date;
  dueAt: Date;
  issuedAt: Date;
};

export function buildInvoiceSnapshot(input: BuildSnapshotInput): InvoiceSnapshot {
  const { order, company } = input;

  // ── the order must be exactly the one that was sold ──
  if (toCents(order.currentTotalPriceSet.shopMoney.amount) !== toCents(order.totalPriceSet.shopMoney.amount)) {
    throw new InvoiceSnapshotError("INVOICE_ORDER_CHANGED", "huidig ordertotaal wijkt af van het oorspronkelijke totaal");
  }
  if (order.lineItems.nodes.some((l) => l.currentQuantity !== l.quantity)) {
    throw new InvoiceSnapshotError("INVOICE_ORDER_CHANGED", "aantallen op de order zijn gewijzigd of terugbetaald");
  }
  const schedule = order.paymentTerms?.paymentSchedules.nodes[0]?.dueAt ?? null;
  if (order.paymentTerms?.paymentTermsType !== "FIXED" || !schedule || new Date(schedule).getTime() !== input.dueAt.getTime()) {
    throw new InvoiceSnapshotError("DUE_DATE_CONFLICT", "vervaldatum op de order wijkt af van de gezette FIXED-termijn");
  }

  // ── supplier (Stones4U) ──
  const missing = (["name", "address", "postcode", "city", "kvk", "vatNumber", "iban"] as const).filter((k) => !company[k]?.trim());
  if (missing.length) throw new InvoiceSnapshotError("COMPANY_PROFILE_INCOMPLETE", `ontbreekt: ${missing.join(", ")}`);

  // ── customer ──
  const customerVat =
    (order.purchasingEntity.__typename === "PurchasingCompany" &&
      "location" in order.purchasingEntity &&
      order.purchasingEntity.location?.taxSettings?.taxRegistrationId) ||
    order.customer?.vatNumber?.value?.trim() ||
    null;
  const fallbackName = order.customer?.displayName ?? null;
  const email = order.email ?? order.customer?.email ?? null;
  // Invoice address: the order's billing address, else the customer's
  // default address, else the order's shipping address (OfferteApp sends the
  // customer's address as shippingAddress on the draft).
  const customer =
    party(order.billingAddress, fallbackName, customerVat, email) ??
    party(order.customer?.defaultAddress ?? null, fallbackName, customerVat, email) ??
    party(order.shippingAddress ?? null, fallbackName, customerVat, email);
  if (!customer) throw new InvoiceSnapshotError("INVOICE_ADDRESS_MISSING", "geen factuuradres op de order, bij de klant of als afleveradres");

  // ── lines and shipping, Shopify's own amounts ──
  const taxesIncluded = order.taxesIncluded;
  const lines: InvoiceLine[] = order.lineItems.nodes.map((l, i) => {
    const gross = toCents(l.originalTotalSet.shopMoney.amount);
    const discount = sum(l.discountAllocations.map((d) => toCents(d.allocatedAmountSet.shopMoney.amount)));
    const tax = onlyTax(l.taxLines, `regel ${i + 1}`);
    const net = gross - discount;
    return {
      title: l.variantTitle ? `${l.title} — ${l.variantTitle}` : l.title,
      sku: l.sku || null,
      quantity: l.quantity,
      unitPriceCents: toCents(l.originalUnitPriceSet.shopMoney.amount),
      unitPriceExclCents: exclOf(toCents(l.originalUnitPriceSet.shopMoney.amount), tax.ratePercentage, taxesIncluded),
      grossCents: gross,
      discountCents: discount,
      netCents: net,
      vatRatePercentage: tax.ratePercentage,
      vatCents: tax.vatCents,
      netExclCents: taxesIncluded ? net - tax.vatCents : net,
    };
  });
  const shipping: InvoiceLine[] = order.shippingLines.nodes.map((s, i) => {
    const gross = toCents(s.originalPriceSet.shopMoney.amount);
    const net = toCents(s.discountedPriceSet.shopMoney.amount);
    const tax = onlyTax(s.taxLines, `verzendregel ${i + 1}`);
    return {
      title: s.title,
      sku: null,
      quantity: 1,
      unitPriceCents: gross,
      unitPriceExclCents: exclOf(gross, tax.ratePercentage, taxesIncluded),
      grossCents: gross,
      discountCents: gross - net,
      netCents: net,
      vatRatePercentage: tax.ratePercentage,
      vatCents: tax.vatCents,
      netExclCents: taxesIncluded ? net - tax.vatCents : net,
    };
  });

  // ── VAT per rate, and the hard consistency checks ──
  const all = [...lines, ...shipping];
  const byRate = new Map<number, { baseExclCents: number; vatCents: number }>();
  for (const l of all) {
    const e = byRate.get(l.vatRatePercentage) ?? { baseExclCents: 0, vatCents: 0 };
    e.baseExclCents += l.netExclCents;
    e.vatCents += l.vatCents;
    byRate.set(l.vatRatePercentage, e);
  }
  const vatSummary = [...byRate.entries()].sort((a, b) => b[0] - a[0]).map(([ratePercentage, v]) => ({ ratePercentage, ...v }));
  const vatCents = sum(all.map((l) => l.vatCents));
  const subtotalExclCents = sum(all.map((l) => l.netExclCents));
  const totalCents = subtotalExclCents + vatCents;
  const shopifyTotal = toCents(order.totalPriceSet.shopMoney.amount);
  const shopifyTax = toCents(order.totalTaxSet.shopMoney.amount);
  if (totalCents !== shopifyTotal) {
    throw new InvoiceSnapshotError("INVOICE_AMOUNTS_INCONSISTENT", `regels tellen op tot ${totalCents} cent, Shopify-totaal is ${shopifyTotal}`);
  }
  if (vatCents !== shopifyTax) {
    throw new InvoiceSnapshotError("INVOICE_AMOUNTS_INCONSISTENT", `btw-regels tellen op tot ${vatCents} cent, Shopify-btw is ${shopifyTax}`);
  }
  const outstandingCents = toCents(order.totalOutstandingSet.shopMoney.amount);

  return {
    version: SNAPSHOT_VERSION,
    invoiceNumber: order.name.replace(/^#/, ""),
    shopifyOrderName: order.name,
    shopifyOrderGid: order.id,
    orderDate: amsterdamDate(new Date(order.createdAt)),
    invoiceDate: amsterdamDate(input.issuedAt),
    deliveryDate: amsterdamDate(input.deliveredAt),
    deliveredAt: input.deliveredAt.toISOString(),
    termDays: input.termDays,
    dueAt: input.dueAt.toISOString(),
    dueDate: amsterdamDate(input.dueAt),
    currency: order.currencyCode,
    taxesIncluded,
    supplier: {
      name: company.name!.trim(),
      address: company.address!.trim(),
      postcode: company.postcode!.trim(),
      city: company.city!.trim(),
      phone: company.phone?.trim() || null,
      email: company.email?.trim() || null,
      website: company.website?.trim() || null,
      kvk: company.kvk!.trim(),
      vatNumber: company.vatNumber!.trim(),
      iban: company.iban!.trim(),
      logoSha256: company.logo ? createHash("sha256").update(company.logo.base64).digest("hex") : null,
    },
    customer,
    lines,
    shipping,
    vatSummary,
    totals: {
      discountCents: sum(lines.map((l) => l.discountCents)) + sum(shipping.map((s) => s.discountCents)),
      shippingCents: sum(shipping.map((s) => s.netCents)),
      subtotalExclCents,
      vatCents,
      totalCents,
      outstandingCents,
    },
  };
}

export function snapshotSha256(snapshot: InvoiceSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

/** "€ 1.234,56" — Dutch formatting, from cents (no floats). */
export function formatEuro(cents: number, currency = "EUR"): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const symbol = currency === "EUR" ? "€" : currency;
  return `${negative ? "-" : ""}${symbol} ${euros},${String(abs % 100).padStart(2, "0")}`;
}

/** "2026-11-20" -> "20-11-2026". */
export function formatDutchDay(isoDay: string): string {
  const [y, m, d] = isoDay.split("-");
  return `${d}-${m}-${y}`;
}
