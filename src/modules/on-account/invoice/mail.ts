// Op rekening v1, Phase I — the ONE invoice mail (subject, HTML, text).
// Everything comes from the stored snapshot; the payment URL is Shopify's
// own additionalPaymentCollectionUrl, read right before sending, and is
// only ever placed in the mail itself — never logged or stored.
import { formatDutchDay, formatEuro, type InvoiceSnapshot } from "./snapshot";

const esc = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function invoiceFilename(snapshot: InvoiceSnapshot): string {
  return `Factuur_${snapshot.invoiceNumber.replace(/[^A-Za-z0-9_-]/g, "")}.pdf`;
}

export function invoiceSubject(snapshot: InvoiceSnapshot): string {
  return `Factuur ${snapshot.supplier.name} ${snapshot.invoiceNumber}`;
}

export type InvoiceMail = { subject: string; html: string; text: string; filename: string };

export function buildInvoiceMail(snapshot: InvoiceSnapshot, paymentUrl: string): InvoiceMail {
  const s = snapshot;
  const greetingName = s.customer.name ?? s.customer.company;
  const greeting = greetingName ? `Beste ${greetingName},` : "Beste klant,";
  const facts: [string, string][] = [
    ["Factuurnummer", s.invoiceNumber],
    ["Factuurdatum", formatDutchDay(s.invoiceDate)],
    ["Leverdatum", formatDutchDay(s.deliveryDate)],
    ["Betaaltermijn", `${s.termDays} dagen`],
    ["Vervaldatum", formatDutchDay(s.dueDate)],
    ["Te betalen", formatEuro(s.totals.outstandingCents, s.currency)],
  ];
  const rows = facts
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 16px 4px 0;color:#5d6675">${esc(label)}</td><td style="padding:4px 0;font-weight:600;color:#1d2430">${esc(value)}</td></tr>`,
    )
    .join("");
  const html = `<!doctype html><html lang="nl"><body style="margin:0;background:#f3f5f7;font-family:Arial,Helvetica,sans-serif;color:#1d2430">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f7;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:6px;border:1px solid #e3e6ea">
<tr><td style="padding:24px 28px 8px;font-size:20px;font-weight:700;color:#1f4e5f">${esc(s.supplier.name)}</td></tr>
<tr><td style="padding:8px 28px;font-size:15px;line-height:1.5">
<p style="margin:0 0 12px">${esc(greeting)}</p>
<p style="margin:0 0 16px">In de bijlage vindt u de factuur voor de geleverde/afgehaalde goederen.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 20px">${rows}</table>
<p style="margin:0 0 24px"><a href="${esc(paymentUrl)}" style="display:inline-block;background:#1f4e5f;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:4px">FACTUUR BETALEN</a></p>
<p style="margin:0 0 6px;font-size:13px;color:#5d6675">U kunt ook overmaken op IBAN ${esc(s.supplier.iban)} t.n.v. ${esc(s.supplier.name)} onder vermelding van factuurnummer ${esc(s.invoiceNumber)}.</p>
<p style="margin:16px 0 0">Met vriendelijke groet,<br>${esc(s.supplier.name)}</p>
</td></tr>
<tr><td style="padding:16px 28px 24px;font-size:11px;color:#8a919c">${esc(s.supplier.name)} · KvK ${esc(s.supplier.kvk)} · Btw ${esc(s.supplier.vatNumber)}${s.supplier.website ? ` · ${esc(s.supplier.website)}` : ""}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    greeting,
    "",
    "In de bijlage vindt u de factuur voor de geleverde/afgehaalde goederen.",
    "",
    ...facts.map(([l, v]) => `${l}: ${v}`),
    "",
    `Factuur betalen: ${paymentUrl}`,
    `Of maak over op IBAN ${s.supplier.iban} t.n.v. ${s.supplier.name} o.v.v. factuurnummer ${s.invoiceNumber}.`,
    "",
    "Met vriendelijke groet,",
    s.supplier.name,
  ].join("\n");
  return { subject: invoiceSubject(s), html, text, filename: invoiceFilename(s) };
}

/** Defence in depth: the URL must be Shopify's https order_payment link on the shop's own domain. */
export function isAcceptablePaymentUrl(url: string, shopDomain: string, orderLegacyId: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    if (u.hostname !== shopDomain) return false;
    const m = /\/order_payment\/(\d+)$/.exec(u.pathname);
    return !!m && m[1] === orderLegacyId;
  } catch {
    return false;
  }
}
