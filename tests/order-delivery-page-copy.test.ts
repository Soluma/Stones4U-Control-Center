import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Phase 6D — same technique as tests/delivery-page-copy.test.ts (this repo
// has no React-component-render test pipeline, see that file's own
// comment for the full reasoning): asserts directly against the Order
// flow's page/form source text. The underlying submit/validation/mirror
// logic is already fully covered at the service layer in
// tests/delivery-handoff.test.ts and tests/order-mirror.test.ts.

const pagePath = fileURLToPath(new URL("../src/app/delivery/[token]/page.tsx", import.meta.url));
const formPath = fileURLToPath(new URL("../src/app/delivery/[token]/OrderDeliveryDateForm.tsx", import.meta.url));

const pageSource = readFileSync(pagePath, "utf-8");
const formSource = readFileSync(formPath, "utf-8");

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

const formSourceFlat = normalizeWhitespace(formSource);

describe("public Order delivery page — dedicated post-order copy (build instruction §5)", () => {
  it("shows the required context, heading, and intro copy", () => {
    expect(formSourceFlat).toContain("Bestelling geplaatst");
    expect(formSourceFlat).toContain("Wanneer mogen we langskomen?");
    expect(formSourceFlat).toContain("Bedankt voor uw bestelling bij Stones4U.");
    expect(formSourceFlat).toContain("Geef aan op welke datum u uw bestelling bij voorkeur wilt ontvangen.");
  });

  it("shows the required field label, helper (preference, not a promise), and primary CTA", () => {
    expect(formSourceFlat).toContain('label="Gewenste leverdatum"');
    expect(formSourceFlat).toContain(
      "De gekozen datum is een voorkeursdatum. De definitieve leverdatum wordt door Stones4U bevestigd.",
    );
    expect(formSourceFlat).toContain("Gewenste leverdatum doorgeven");
  });

  it("shows the 'what happens next' section", () => {
    expect(formSourceFlat).toContain("Wat gebeurt er daarna?");
    expect(formSourceFlat).toContain("Wij nemen uw voorkeursdatum mee in onze planning.");
  });

  it("never shows the Draft flow's checkout-step framing or payment CTA (build instruction §5 — must not implicitly reuse the checkout copy)", () => {
    expect(formSourceFlat).not.toContain("Bestelling afronden");
    expect(formSourceFlat).not.toContain("1. Gewenste leverdatum");
    expect(formSourceFlat).not.toContain("Factuur & betaling");
    expect(formSourceFlat).not.toContain("Leverdatum opslaan en verder naar factuur");
    expect(formSourceFlat).not.toMatch(/\bfactuur\b/i);
    expect(formSourceFlat).not.toMatch(/\bbetaling\b/i);
    expect(formSourceFlat).not.toMatch(/\bcheckout\b/i);
    expect(formSourceFlat).not.toMatch(/\binvoice\b/i);
  });
});

describe("public Order delivery page — success state (build instructions §8, §9)", () => {
  it("shows the required success copy — thanks, no redirect language, preference/planning framing", () => {
    expect(formSourceFlat).toContain("Bedankt!");
    expect(formSourceFlat).toContain("Uw gewenste leverdatum is doorgegeven.");
    expect(formSourceFlat).toContain("We nemen deze voorkeur mee in onze planning.");
    expect(formSourceFlat).toContain("De definitieve leverdatum wordt door Stones4U bevestigd.");
  });

  it("formats the confirmed date in Dutch long form via the shared formatter, never a raw ISO string", () => {
    expect(formSource).toContain('import { formatDateLong } from "@/lib/format"');
    expect(formSource).toContain("formatDateLong(succeeded.requestedDeliveryDate)");
  });

  it("never uses payment/redirect language in the success state", () => {
    expect(formSourceFlat).not.toMatch(/\bfactuur\b/i);
    expect(formSourceFlat).not.toMatch(/\bbetaling\b/i);
    expect(formSource).not.toContain("window.location.href");
    expect(formSource).not.toContain("redirectUrl");
  });

  it("never implies a confirmed/guaranteed delivery date or a transport promise, anywhere in this file", () => {
    const forbidden = [/Uw levering vindt plaats op/i, /bevestigde leverdatum/i, /definitieve leverdatum is/i, /wordt geleverd op/i];
    for (const pattern of forbidden) {
      expect(formSourceFlat).not.toMatch(pattern);
    }
  });
});

describe("public Order delivery page — safe publicReference rendering (build instruction §6)", () => {
  it("renders publicReference only behind an existence check, as plain interpolated text", () => {
    expect(formSource).toContain("{publicReference &&");
    expect(formSource).toContain("Bestelling {publicReference}");
    expect(formSource).not.toContain("dangerouslySetInnerHTML");
  });

  it("never exposes a Shopify GID, Draft GID, CRM id, customerProfileId, or webhook metadata", () => {
    for (const source of [pageSource, formSource]) {
      expect(source).not.toMatch(/gid:\/\/shopify/i);
      expect(source).not.toContain("shopifyOrderGid");
      expect(source).not.toContain("shopifyDraftOrderGid");
      expect(source).not.toContain("externalId");
      expect(source).not.toContain("customerProfileId");
      expect(source).not.toMatch(/webhookId|webhook_id/i);
    }
  });

  it("never shows customer PII (email, phone, address) anywhere in the Order flow's page or form", () => {
    for (const source of [pageSource, formSourceFlat]) {
      expect(source).not.toMatch(/\bemail\b/i);
      expect(source).not.toMatch(/\bphone\b|\btelefoon\b/i);
      expect(source).not.toMatch(/\baddress\b|\badres\b/i);
    }
  });
});

describe("public Order delivery page — the client cannot supply anything the server must resolve itself (build instruction §18)", () => {
  it("the POST body sent by the client carries only the chosen date", () => {
    const bodyLiteralMatch = formSource.match(/body:\s*JSON\.stringify\(\{([^}]*)\}\)/);
    expect(bodyLiteralMatch).not.toBeNull();
    const bodyLiteral = bodyLiteralMatch![1]!;
    expect(bodyLiteral.trim()).toBe("requestedDeliveryDate: date");
  });

  it("never constructs or sends an orderGid, draftOrderGid, commerceObjectType, shop domain, redirect URL, or payment target from the client", () => {
    for (const forbidden of [
      "orderGid",
      "draftOrderGid",
      "commerceObjectType",
      "shopDomain",
      "shop:",
      "redirectUrl:",
      "paymentTarget",
    ]) {
      expect(formSource).not.toContain(forbidden);
    }
  });
});

describe("public delivery page — server-side branch dispatch stays fail-closed (build instruction §3)", () => {
  it("page.tsx dispatches on the persisted handoff.commerceObjectType only, and fails closed (404) for anything unrecognized", () => {
    expect(pageSource).toContain('handoff.commerceObjectType === "SHOPIFY_ORDER"');
    expect(pageSource).toContain('handoff.commerceObjectType !== "SHOPIFY_DRAFT_ORDER"');
    expect(pageSource).toContain("notFound()");
    expect(pageSource).not.toMatch(/gid:\/\/shopify/i);
  });

  it("the Draft branch still renders the original DeliveryDateForm, untouched", () => {
    expect(pageSource).toContain("<DeliveryDateForm");
    expect(pageSource).toContain("<OrderDeliveryDateForm");
  });
});

describe("public Order delivery page — existing date prefill (build instruction §19)", () => {
  it("passes the handoff's already-stored requestedDeliveryDate through to the Order form as currentValue, same as the Draft branch", () => {
    const orderFormCallSite = pageSource.slice(pageSource.indexOf("<OrderDeliveryDateForm"));
    expect(orderFormCallSite).toContain("currentValue={handoff.requestedDeliveryDate");
    expect(orderFormCallSite).toContain("publicReference={handoff.publicReference}");
  });

  it("the form actually renders the prefilled value into the date input", () => {
    expect(formSourceFlat).toContain("useState(currentValue)");
    expect(formSourceFlat).toContain("value={date}");
  });
});
