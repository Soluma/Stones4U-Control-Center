import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Phase 5C-B — customer page UX. This repo has no React-component-render
// test pipeline (vitest.config.mts runs environment: "node", no
// testing-library/jsdom, and only "tests/**/*.test.ts" is included — no
// .tsx component test exists anywhere in this repo), consistent with its
// established "service-layer only, no route-level tests" convention.
// Setting up a whole render pipeline for one presentation-only page would
// be disproportionate infrastructure for this task, so this file instead
// asserts directly against the page/form source text — a lightweight,
// reliable regression guard for exact customer-facing copy, forbidden
// guarantee-implying language, and PII leakage, without introducing new
// test tooling. The underlying submit/validation/mirror logic this copy
// wraps is already fully covered at the service layer in
// tests/delivery-handoff.test.ts and is untouched by this change.

const pagePath = fileURLToPath(new URL("../src/app/delivery/[token]/page.tsx", import.meta.url));
const formPath = fileURLToPath(new URL("../src/app/delivery/[token]/DeliveryDateForm.tsx", import.meta.url));

const pageSource = readFileSync(pagePath, "utf-8");
const formSource = readFileSync(formPath, "utf-8");

// JSX text is wrapped across lines for readability, so the raw source
// contains line breaks/indentation a rendered page would collapse — this
// normalizes runs of whitespace to a single space before substring checks
// that span a wrapped paragraph.
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

const pageSourceFlat = normalizeWhitespace(pageSource);
const formSourceFlat = normalizeWhitespace(formSource);
// Phase 6T — the date field moved into the shared field component.
const sharedFieldsSource = normalizeWhitespace(
  readFileSync(fileURLToPath(new URL("../src/app/delivery/[token]/DeliveryLogisticsFields.tsx", import.meta.url)), "utf-8"),
);


describe("public delivery page — customer-facing copy", () => {
  it("shows the required heading, intro, and step context", () => {
    expect(pageSourceFlat).toContain("Wanneer mogen we langskomen?");
    expect(pageSourceFlat).toContain(
      "Geef aan welke leverdatum u het beste uitkomt. We doen ons best om uw bestelling op deze datum te leveren.",
    );
    expect(pageSourceFlat).toContain("Bestelling afronden");
    expect(pageSourceFlat).toContain("Gewenste leverdatum");
    expect(pageSourceFlat).toContain("Factuur");
  });

  it("shows the 'what happens next' explanation, framed as a preference, never a promise", () => {
    expect(pageSourceFlat).toContain("Wat gebeurt er daarna?");
    expect(pageSourceFlat).toContain("Uw voorkeursdatum");
    expect(pageSourceFlat).toContain("wordt bij uw bestelling opgeslagen en meegenomen in onze planning");
    expect(pageSourceFlat).toContain("pas definitief nadat deze door Stones4U is bevestigd");
  });

  it("never fabricates an order/draft reference — no Shopify GID or internal identifier is rendered", () => {
    expect(pageSource).not.toMatch(/gid:\/\/shopify/i);
    expect(pageSource).not.toContain("shopifyDraftOrderGid");
    expect(pageSource).not.toContain("externalId");
  });

  it("never shows customer PII (email, phone, address) on the public page", () => {
    expect(pageSource).not.toMatch(/\bemail\b/i);
    expect(pageSource).not.toMatch(/\bphone\b|\btelefoon\b/i);
    expect(pageSource).not.toMatch(/\baddress\b|\badres\b/i);
  });

  it("uses the required date-field label and helper text, framed as a preference", () => {
    expect(sharedFieldsSource).toContain('label="Gewenste leverdatum"');
    expect(sharedFieldsSource).toContain(
      "De gekozen datum is een voorkeursdatum. De definitieve leverdatum wordt door Stones4U bevestigd.",
    );
  });

  it("uses the required primary button label", () => {
    expect(formSourceFlat).toContain("Leverdatum opslaan en verder naar factuur");
    expect(formSourceFlat).not.toContain("Verder naar betaling");
  });

  it("never uses language that implies a confirmed/guaranteed delivery date, anywhere in the public page or form", () => {
    const forbidden = [/Uw levering vindt plaats op/i, /bevestigde leverdatum/i, /definitieve leverdatum is/i];
    for (const pattern of forbidden) {
      expect(pageSourceFlat).not.toMatch(pattern);
      expect(formSourceFlat).not.toMatch(pattern);
    }
  });

  it("leaves the existing submit/redirect/error-handling logic untouched (presentation-only change)", () => {
    expect(formSource).toContain("fetch(`/api/delivery/${encodeURIComponent(token)}`");
    expect(formSource).toContain("window.location.href = body.redirectUrl");
    expect(formSource).toContain("setError(body.error ?? ");
  });
});
