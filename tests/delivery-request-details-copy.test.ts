import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Phase 6P — same source-text technique as the other copy tests in this repo
// (there is no route/render pipeline here). Locks the customer-facing wording
// and, more importantly, the safety properties of the form.

const orderForm = readFileSync(
  fileURLToPath(new URL("../src/app/delivery/[token]/OrderDeliveryDateForm.tsx", import.meta.url)),
  "utf-8",
);
const page = readFileSync(
  fileURLToPath(new URL("../src/app/delivery/[token]/page.tsx", import.meta.url)),
  "utf-8",
);
const staffClient = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/delivery-handoffs/DeliveryHandoffsClient.tsx", import.meta.url)),
  "utf-8",
);
const service = readFileSync(
  fileURLToPath(new URL("../src/modules/delivery/delivery-handoff.service.ts", import.meta.url)),
  "utf-8",
);

describe("customer form — lead-time copy", () => {
  it("explains the Monday-to-Friday window and that weekends do not count", () => {
    expect(orderForm).toContain("Wij leveren van maandag t/m vrijdag");
    expect(orderForm).toContain("twee volledige werkdagen");
    expect(orderForm).toContain("Zaterdag en zondag tellen niet mee");
  });

  it("still frames the date as a preference, never a confirmed delivery date", () => {
    expect(orderForm).toContain("voorkeursdatum");
    expect(orderForm).toContain("wordt door Stones4U bevestigd");
  });

  it("uses the server-computed earliest date as the picker minimum, not a client-side today", () => {
    expect(orderForm).toContain("min={earliestDeliveryDate}");
    expect(orderForm).not.toContain("todayIsoDate");
  });

  it("the earliest date is computed on the server page, in the delivery policy module", () => {
    expect(page).toContain("getEarliestRequestedDeliveryDate");
    expect(page).toContain("earliestDeliveryDate=");
  });
});

describe("customer form — truck access", () => {
  it("asks the accessibility question with the agreed wording and helper text", () => {
    expect(orderForm).toContain("Ja, de afleverlocatie is bereikbaar met een grote vrachtwagen.");
    expect(orderForm).toContain("Denk aan voldoende ruimte om de locatie te bereiken, te manoeuvreren en te lossen.");
  });

  it("is a checkbox, and never blocks submitting when left unchecked", () => {
    expect(orderForm).toContain('type="checkbox"');
    // The submit button carries no disabled-by-accessibility condition.
    expect(orderForm).not.toMatch(/disabled=\{[^}]*largeTruckAccessConfirmed/);
  });

  it("the success screen reports confirmed / not confirmed, never 'inaccessible'", () => {
    expect(orderForm).toContain("Bereikbaarheid grote vrachtwagen");
    expect(orderForm).toContain("Niet bevestigd");
    expect(orderForm).not.toMatch(/onbereikbaar|niet bereikbaar/i);
  });
});

describe("customer form — delivery comment", () => {
  it("is optional, labelled and placeholdered as agreed", () => {
    expect(orderForm).toContain("Opmerking voor de levering (optioneel)");
    expect(orderForm).toContain("graag bellen bij aankomst");
  });

  it("caps the length in the textarea as a UX hint", () => {
    expect(orderForm).toContain("maxLength={DELIVERY_COMMENT_MAX_LENGTH}");
  });

  it("does not echo the free-text remark back on the success screen", () => {
    const successBlock = orderForm.slice(
      orderForm.indexOf("if (succeeded)"),
      orderForm.indexOf('<div className="mb-8 text-center">'),
    );
    expect(successBlock.length).toBeGreaterThan(200);
    expect(successBlock).not.toContain("deliveryComment");
  });
});

describe("staff view", () => {
  it("shows all three delivery details, with 'geen opmerking' when absent", () => {
    expect(staffClient).toContain("formatLargeTruckAccess");
    expect(staffClient).toContain("Opmerking voor levering");
    expect(staffClient).toContain("geen opmerking");
  });

  it("renders the remark as plain text — never as HTML", () => {
    expect(staffClient).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("server-side safety", () => {
  it("the submission service validates via the canonical policy, not its own date maths", () => {
    expect(service).toContain("validateRequestedDeliveryDate");
    // No hour/millisecond lead-time arithmetic anywhere in the service.
    expect(service).not.toMatch(/60 \* 60 \* 1000/);
  });

  it("both the Order and the Draft flow apply the same date policy", () => {
    const occurrences = service.match(/validateRequestedDeliveryDate\(\{/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it("the free-text remark never reaches audit metadata — only a boolean does", () => {
    expect(service).toContain("hasDeliveryComment");
    expect(service).not.toMatch(/metadata:\s*\{[^}]*deliveryComment:/);
  });

  it("the remark and truck answer are never mirrored to Shopify", () => {
    const mirror = readFileSync(
      fileURLToPath(new URL("../src/integrations/shopify/order-mirror.ts", import.meta.url)),
      "utf-8",
    );
    expect(mirror).not.toContain("deliveryComment");
    expect(mirror).not.toContain("largeTruckAccessConfirmed");
    expect(mirror).toContain("requested_delivery_date");
  });
});
