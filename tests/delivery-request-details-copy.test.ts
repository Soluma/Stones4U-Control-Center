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

// Phase 6W build instruction §26 — the legacy pre-payment Draft form had been
// left on a browser-clock minimum, which is what produced the mismatch Fons
// reported from production: the picker offered 11-09-2026 while the server's
// earliest valid date was 15-09-2026. The server was never wrong; the picker
// was offering what the server would refuse.
describe("legacy Draft form — date minimum matches the authoritative server policy (§26)", () => {
  const draftForm = readFileSync(
    fileURLToPath(new URL("../src/app/delivery/[token]/DeliveryDateForm.tsx", import.meta.url)),
    "utf-8",
  );

  it("uses the server-computed earliest date, never a client-side today", () => {
    expect(draftForm).toContain("min={earliestDeliveryDate}");
    // The minimum arrives as a prop rather than being derived in the browser.
    expect(draftForm).toMatch(/earliestDeliveryDate:\s*string/);
    expect(draftForm).not.toContain("todayIsoDate");
    // Assert on code, not prose: the doc comment above the component
    // deliberately explains what `new Date()` used to do here.
    const code = draftForm.replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("new Date(");
  });

  it("the page computes it from the same inputs the POST handler validates with", () => {
    const draftCallSite = page.slice(page.indexOf("<DeliveryDateForm"));
    expect(draftCallSite).toContain("earliestDeliveryDate={getEarliestRequestedDeliveryDate({");
    expect(draftCallSite).toContain("orderCreatedAt: handoff.createdAt");
    // submitRequestedDeliveryDate() validates with exactly these two inputs.
    expect(service).toContain("orderCreatedAt: handoff.createdAt");
  });

  it("stays date-only — §26 explicitly does NOT add truck access or a comment to the legacy form", () => {
    expect(draftForm).not.toContain("grote vrachtwagen");
    expect(draftForm).not.toContain("Opmerking voor de levering");
    expect(draftForm).not.toContain("largeTruckAccessConfirmed");
    expect(draftForm).not.toContain("deliveryComment");
  });

  it("leaves the payment redirect untouched", () => {
    expect(draftForm).toContain("window.location.href = body.redirectUrl");
    expect(draftForm).toContain("Leverdatum opslaan en verder naar factuur");
  });
});

// Phase 6R — the form must show the customer their own last answers back.
// Before this, reopening a link presented an empty comment box and an
// unticked checkbox, so an otherwise innocent resubmission silently wiped
// both. There is no render pipeline in this repo, so the guarantee is
// asserted at the two places that actually produce it.
describe("customer form — prefill from persisted state", () => {
  it("seeds the comment box from the persisted value, with null becoming an empty box", () => {
    expect(orderForm).toContain('useState(currentDeliveryComment ?? "")');
  });

  it("ticks the checkbox only for a persisted true — false and null both render unticked", () => {
    expect(orderForm).toContain("useState(currentLargeTruckAccessConfirmed === true)");
  });

  it("still seeds the date from the persisted value", () => {
    expect(orderForm).toContain("useState(currentValue)");
  });

  it("the page supplies those values from the persisted handoff, not from Shopify or the browser", () => {
    expect(page).toContain("currentDeliveryComment={handoff.deliveryComment}");
    expect(page).toContain("currentLargeTruckAccessConfirmed={handoff.largeTruckAccessConfirmed}");
    // Viewing must never reconcile against Shopify (build instruction §12).
    expect(page).not.toContain("readOrderLogisticsMetafields");
  });

  it("never uses browser storage to carry customer answers", () => {
    for (const forbidden of ["localStorage", "sessionStorage", "document.cookie"]) {
      expect(orderForm).not.toContain(forbidden);
      expect(page).not.toContain(forbidden);
    }
  });

  it("renders the persisted comment as plain text — the textarea value, never HTML", () => {
    expect(orderForm).toContain("value={deliveryComment}");
    expect(orderForm).not.toContain("dangerouslySetInnerHTML");
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

  // Phase 6R — the remark and truck answer DO reach Shopify now, but through
  // the dedicated metafield writer, never through the customAttribute mirror.
  // The two paths stay separate so a failure or change in one cannot disturb
  // the other.
  it("the customAttribute mirror still carries only requested_delivery_date", () => {
    const mirror = readFileSync(
      fileURLToPath(new URL("../src/integrations/shopify/order-mirror.ts", import.meta.url)),
      "utf-8",
    );
    expect(mirror).not.toContain("deliveryComment");
    expect(mirror).not.toContain("largeTruckAccessConfirmed");
    expect(mirror).toContain("requested_delivery_date");
  });

  it("the logistics metafield writer is a separate path that never touches the date attribute", () => {
    const metafields = readFileSync(
      fileURLToPath(new URL("../src/integrations/shopify/order-logistics-metafields.ts", import.meta.url)),
      "utf-8",
    );
    expect(metafields).toContain("delivery_comment");
    expect(metafields).toContain("large_truck_access_confirmed");
    expect(metafields).toContain("metafieldsSet");
    // The GraphQL it sends contains no orderUpdate/customAttributes operation.
    expect(metafields).not.toMatch(/mutation[\s\S]*orderUpdate/);
  });
});
