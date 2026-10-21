// Op rekening v1, Phase I — the ONE Stones4U invoice layout (server-side,
// pdfkit, A4). Renders only what is in the stored snapshot (Shopify's own
// amounts), so the PDF can never disagree with the snapshot it came from.
// The company logo is the one configured in OfferteApp Settings.
import PDFDocument from "pdfkit";
import { formatDutchDay, formatEuro, type InvoiceLine, type InvoiceSnapshot } from "./snapshot";

const INK = "#1d2430";
const MUTED = "#5d6675";
const RULE = "#d9dde3";
const ACCENT = "#1f4e5f";
const PAGE = { margin: 48, width: 595.28, height: 841.89 };
const CONTENT_W = PAGE.width - PAGE.margin * 2;

export type RenderInput = { snapshot: InvoiceSnapshot; logo: { mime: string; base64: string } | null };

const pct = (rate: number) => `${Number.isInteger(rate) ? rate : rate.toFixed(2).replace(".", ",")}%`;

export async function renderInvoicePdf({ snapshot: s, logo }: RenderInput): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: PAGE.margin, bottom: PAGE.margin + 18, left: PAGE.margin, right: PAGE.margin },
    bufferPages: true,
    info: {
      Title: `Factuur ${s.invoiceNumber}`,
      Author: s.supplier.name,
      Subject: `Factuur ${s.invoiceNumber} — Shopify-order ${s.shopifyOrderName}`,
      CreationDate: new Date(`${s.invoiceDate}T12:00:00Z`),
      ModDate: new Date(`${s.invoiceDate}T12:00:00Z`),
    },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const left = PAGE.margin;
  let y = PAGE.margin;

  // ── header: logo + FACTUUR ──
  let logoDrawn = false;
  if (logo && /^image\/(png|jpe?g)$/i.test(logo.mime)) {
    try {
      doc.image(Buffer.from(logo.base64, "base64"), left, y, { fit: [170, 54] });
      logoDrawn = true;
    } catch {
      logoDrawn = false;
    }
  }
  if (!logoDrawn) doc.font("Helvetica-Bold").fontSize(18).fillColor(ACCENT).text(s.supplier.name, left, y + 14, { width: 260 });
  doc.font("Helvetica-Bold").fontSize(26).fillColor(INK).text("FACTUUR", left, y + 6, { width: CONTENT_W, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(`Factuurnummer ${s.invoiceNumber}`, left, y + 38, { width: CONTENT_W, align: "right" });
  y += 74;
  doc.moveTo(left, y).lineTo(left + CONTENT_W, y).lineWidth(1).strokeColor(ACCENT).stroke();
  y += 16;

  // ── supplier | customer ──
  const colW = (CONTENT_W - 24) / 2;
  const supplierLines = [
    s.supplier.address,
    `${s.supplier.postcode}  ${s.supplier.city}`,
    s.supplier.phone ? `Tel. ${s.supplier.phone}` : null,
    s.supplier.email,
    s.supplier.website,
    `KvK ${s.supplier.kvk}`,
    `Btw-nummer ${s.supplier.vatNumber}`,
    `IBAN ${s.supplier.iban}`,
  ].filter((l): l is string => !!l);
  const customerLines = [
    s.customer.company && s.customer.name && s.customer.company !== s.customer.name ? `t.a.v. ${s.customer.name}` : null,
    ...s.customer.addressLines,
    s.customer.country,
    s.customer.vatNumber ? `Btw-nummer ${s.customer.vatNumber}` : null,
  ].filter((l): l is string => !!l);

  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text("VAN", left, y, { characterSpacing: 0.8 });
  doc.text("FACTUUR AAN", left + colW + 24, y, { characterSpacing: 0.8 });
  y += 12;
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(INK).text(s.supplier.name, left, y, { width: colW });
  doc.text(s.customer.company ?? s.customer.name ?? "", left + colW + 24, y, { width: colW });
  y += 14;
  doc.font("Helvetica").fontSize(9.5).fillColor(INK);
  const supplierBottom = (() => {
    let yy = y;
    for (const line of supplierLines) {
      doc.text(line, left, yy, { width: colW });
      yy += 12.5;
    }
    return yy;
  })();
  let yy = y;
  for (const line of customerLines) {
    doc.text(line, left + colW + 24, yy, { width: colW });
    yy += 12.5;
  }
  y = Math.max(supplierBottom, yy) + 14;

  // ── invoice facts ──
  const facts: [string, string][] = [
    ["Factuurnummer", s.invoiceNumber],
    ["Factuurdatum", formatDutchDay(s.invoiceDate)],
    ["Leverdatum / afhaaldatum", formatDutchDay(s.deliveryDate)],
    ["Shopify-order", `${s.shopifyOrderName} (${formatDutchDay(s.orderDate)})`],
    ["Betaaltermijn", `${s.termDays} dagen na levering`],
    ["Vervaldatum", formatDutchDay(s.dueDate)],
  ];
  const factW = CONTENT_W / 3;
  doc.roundedRect(left, y, CONTENT_W, 62, 4).fillColor("#f3f5f7").fill();
  facts.forEach(([label, value], i) => {
    const fx = left + 12 + (i % 3) * factW;
    const fy = y + 10 + Math.floor(i / 3) * 26;
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED).text(label.toUpperCase(), fx, fy, { width: factW - 16, characterSpacing: 0.5 });
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(value, fx, fy + 10, { width: factW - 16 });
  });
  y += 80;

  // ── lines table ──
  const DESC_W = 171;
  const cols = [
    { key: "desc", label: "Omschrijving", w: DESC_W, align: "left" as const },
    { key: "qty", label: "Aantal", w: 34, align: "right" as const },
    { key: "unit", label: "Prijs p.st. excl.", w: 62, align: "right" as const },
    { key: "disc", label: "Korting incl.", w: 54, align: "right" as const },
    { key: "excl", label: "Bedrag excl.", w: 60, align: "right" as const },
    { key: "vat", label: "Btw", w: 28, align: "right" as const },
    { key: "incl", label: "Bedrag incl.", w: 60, align: "right" as const },
  ];
  const tableHeader = () => {
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED);
    let x = left;
    for (const c of cols) {
      doc.text(c.label, x, y, { width: c.w, align: c.align });
      x += c.w + 4;
    }
    y += 13;
    doc.moveTo(left, y).lineTo(left + CONTENT_W, y).lineWidth(0.6).strokeColor(RULE).stroke();
    y += 6;
  };
  tableHeader();
  const row = (line: InvoiceLine, prefix = "") => {
    const desc = `${prefix}${line.title}${line.sku ? `\nArt.nr. ${line.sku}` : ""}`;
    doc.font("Helvetica").fontSize(9);
    const h = Math.max(doc.heightOfString(desc, { width: DESC_W }), 11);
    if (y + h > PAGE.height - PAGE.margin - 150) {
      doc.addPage();
      y = PAGE.margin;
      tableHeader();
    }
    const cells: Record<string, string> = {
      desc,
      qty: String(line.quantity),
      unit: formatEuro(line.unitPriceExclCents, s.currency),
      disc: line.discountCents ? `-${formatEuro(line.discountCents, s.currency)}` : "",
      excl: formatEuro(line.netExclCents, s.currency),
      vat: pct(line.vatRatePercentage),
      incl: formatEuro(line.netExclCents + line.vatCents, s.currency),
    };
    let x = left;
    doc.fillColor(INK);
    for (const c of cols) {
      doc.text(cells[c.key] ?? "", x, y, { width: c.w, align: c.align });
      x += c.w + 4;
    }
    y += h + 6;
    doc.moveTo(left, y - 3).lineTo(left + CONTENT_W, y - 3).lineWidth(0.3).strokeColor(RULE).stroke();
  };
  s.lines.forEach((l) => row(l));
  s.shipping.forEach((l) => row(l, "Verzending / transport: "));
  y += 6;

  // ── totals ──
  if (y > PAGE.height - PAGE.margin - 170) {
    doc.addPage();
    y = PAGE.margin;
  }
  const totalsX = left + CONTENT_W - 240;
  const totalRow = (label: string, value: string, bold = false) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9.5).fillColor(INK);
    doc.text(label, totalsX, y, { width: 150 });
    doc.text(value, totalsX + 150, y, { width: 90, align: "right" });
    y += bold ? 17 : 14;
  };
  if (s.totals.discountCents) totalRow("Waarvan korting (incl.)", `-${formatEuro(s.totals.discountCents, s.currency)}`);
  totalRow("Subtotaal excl. btw", formatEuro(s.totals.subtotalExclCents, s.currency));
  for (const v of s.vatSummary) {
    totalRow(`Btw ${pct(v.ratePercentage)} over ${formatEuro(v.baseExclCents, s.currency)}`, formatEuro(v.vatCents, s.currency));
  }
  doc.moveTo(totalsX, y).lineTo(totalsX + 240, y).lineWidth(0.8).strokeColor(INK).stroke();
  y += 6;
  totalRow("Totaal incl. btw", formatEuro(s.totals.totalCents, s.currency), true);
  totalRow("Openstaand bedrag", formatEuro(s.totals.outstandingCents, s.currency), true);
  y += 12;

  // ── payment instruction ──
  doc.font("Helvetica").fontSize(9.5).fillColor(INK).text(
    `Gelieve het openstaande bedrag van ${formatEuro(s.totals.outstandingCents, s.currency)} uiterlijk ${formatDutchDay(s.dueDate)} te voldoen ` +
      `via de betaallink in de begeleidende e-mail, of over te maken op IBAN ${s.supplier.iban} t.n.v. ${s.supplier.name} ` +
      `onder vermelding van factuurnummer ${s.invoiceNumber}.`,
    left,
    y,
    { width: CONTENT_W },
  );

  // ── footer on every page ──
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // The footer sits below the bottom margin; without this pdfkit would
    // start a new page for it.
    doc.page.margins.bottom = 0;
    const fy = PAGE.height - PAGE.margin + 4;
    doc.font("Helvetica").fontSize(7.5).fillColor(MUTED);
    doc.text(
      `${s.supplier.name} · KvK ${s.supplier.kvk} · Btw ${s.supplier.vatNumber} · IBAN ${s.supplier.iban}`,
      left,
      fy,
      { width: CONTENT_W - 80, lineBreak: false },
    );
    doc.text(`Pagina ${i - range.start + 1} van ${range.count}`, left + CONTENT_W - 80, fy, { width: 80, align: "right", lineBreak: false });
  }
  doc.end();
  return done;
}
