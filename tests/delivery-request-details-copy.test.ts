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
const draftForm = readFileSync(
  fileURLToPath(new URL("../src/app/delivery/[token]/DeliveryDateForm.tsx", import.meta.url)),
  "utf-8",
);
const sharedFields = readFileSync(
  fileURLToPath(new URL("../src/app/delivery/[token]/DeliveryLogisticsFields.tsx", import.meta.url)),
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
    expect(sharedFields).toContain("Wij leveren van maandag t/m vrijdag");
    expect(sharedFields).toContain("twee volledige werkdagen");
    expect(sharedFields).toContain("Zaterdag en zondag tellen niet mee");
  });

  it("still frames the date as a preference, never a confirmed delivery date", () => {
    expect(orderForm).toContain("voorkeursdatum");
    expect(orderForm).toContain("wordt door Stones4U bevestigd");
  });

  it("uses the server-computed earliest date as the picker minimum, not a client-side today", () => {
    expect(sharedFields).toContain("min={earliestDeliveryDate}");
    for (const f of [sharedFields, orderForm, draftForm]) expect(f).not.toContain("todayIsoDate");
  });

  it("the earliest date is computed on the server page, in the delivery policy module", () => {
    expect(page).toContain("getEarliestRequestedDeliveryDate");
    expect(page).toContain("earliestDeliveryDate=");
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
    expect(sharedFields).toContain("value={deliveryComment}");
    expect(sharedFields).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("customer form — truck access", () => {
  it("asks the accessibility question with the agreed wording and helper text", () => {
    expect(sharedFields).toContain("Ja, de afleverlocatie is bereikbaar met een grote vrachtwagen.");
    expect(sharedFields).toContain("Denk aan voldoende ruimte om de locatie te bereiken, te manoeuvreren en te lossen.");
  });

  it("is a checkbox, and never blocks submitting when left unchecked", () => {
    expect(sharedFields).toContain('type="checkbox"');
    // No submit button anywhere is disabled by the accessibility answer.
    for (const f of [orderForm, draftForm]) expect(f).not.toMatch(/disabled=\{[^}]*largeTruckAccessConfirmed/);
  });

  it("the success screen reports confirmed / not confirmed, never 'inaccessible'", () => {
    expect(orderForm).toContain("Bereikbaarheid grote vrachtwagen");
    expect(orderForm).toContain("Niet bevestigd");
    expect(orderForm).not.toMatch(/onbereikbaar|niet bereikbaar/i);
  });
});

describe("customer form — delivery comment", () => {
  it("is optional, labelled and placeholdered as agreed", () => {
    expect(sharedFields).toContain("Opmerking voor de levering (optioneel)");
    expect(sharedFields).toContain("graag bellen bij aankomst");
  });

  it("caps the length in the textarea as a UX hint", () => {
    expect(sharedFields).toContain("maxLength={DELIVERY_COMMENT_MAX_LENGTH}");
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

// Phase 6T — the Draft flow asked only for a date, with a client-side `today`
// minimum that offered dates the server already rejected. Both flows now share
// one field component, which is what stops them drifting apart again.
describe("Draft flow — unified with the Order flow", () => {
  it("both forms render the same shared field component", () => {
    expect(draftForm).toContain("DeliveryLogisticsFields");
    expect(orderForm).toContain("DeliveryLogisticsFields");
  });

  it("the shared component owns the date rules, truck question and remark exactly once", () => {
    expect(sharedFields).toContain("Wij leveren van maandag t/m vrijdag");
    expect(sharedFields).toContain("Ja, de afleverlocatie is bereikbaar met een grote vrachtwagen.");
    expect(sharedFields).toContain("Opmerking voor de levering (optioneel)");
    expect(sharedFields).toContain("min={earliestDeliveryDate}");
    expect(sharedFields).toContain("maxLength={DELIVERY_COMMENT_MAX_LENGTH}");
    // Neither form re-declares the copy or the rules itself.
    for (const form of [draftForm, orderForm]) {
      expect(form).not.toContain("Wij leveren van maandag t/m vrijdag");
      expect(form).not.toContain("Ja, de afleverlocatie is bereikbaar");
    }
  });

  it("the Draft form no longer uses a client-side today as the picker minimum", () => {
    expect(draftForm).not.toContain("todayIsoDate");
    expect(draftForm).toContain("earliestDeliveryDate");
  });

  it("the Draft form sends the logistics answers alongside the date", () => {
    const body = draftForm.match(/body:\s*JSON\.stringify\(\{([^}]*)\}\)/)![1]!;
    const fields = body.split(",").map((f) => f.trim()).filter(Boolean);
    expect(new Set(fields)).toEqual(
      new Set(["requestedDeliveryDate: date", "deliveryComment", "largeTruckAccessConfirmed"]),
    );
  });

  it("the Draft form prefills all three from the persisted handoff", () => {
    expect(draftForm).toContain("useState(currentValue)");
    expect(draftForm).toContain('useState(currentDeliveryComment ?? "")');
    expect(draftForm).toContain("currentLargeTruckAccessConfirmed === true");
    expect(page).toContain("currentDeliveryComment={handoff.deliveryComment}");
  });

  it("the Draft form never uses browser storage", () => {
    for (const forbidden of ["localStorage", "sessionStorage", "document.cookie"]) {
      expect(draftForm).not.toContain(forbidden);
    }
  });

  it("the Draft payment redirect is untouched — still the server-supplied redirectUrl", () => {
    expect(draftForm).toContain("window.location.href = body.redirectUrl");
    expect(draftForm).toContain("Leverdatum opslaan en verder naar factuur");
  });

  it("the Draft flow does not write Shopify metafields — they do not survive draftOrderComplete", () => {
    // Asserted on behaviour, not on prose: the Draft path must not call the
    // metafield mirror at all, while the Order path must.
    const draftFn = service.slice(
      service.indexOf("export async function submitRequestedDeliveryDate("),
      service.indexOf("export async function submitRequestedDeliveryDateForOrder("),
    );
    expect(draftFn.length).toBeGreaterThan(500);
    expect(draftFn).not.toContain("mirrorOrderLogisticsMetafields");
    const orderFn = service.slice(service.indexOf("export async function submitRequestedDeliveryDateForOrder("));
    expect(orderFn).toContain("mirrorOrderLogisticsMetafields");
  });
});
