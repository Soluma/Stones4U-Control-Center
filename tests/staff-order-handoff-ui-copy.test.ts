import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Phase 6E final review — same source-text technique as
// tests/delivery-page-copy.test.ts / tests/order-delivery-page-copy.test.ts
// (this repo has no React-component-render test pipeline). Confirms the
// staff management UI's existing-date wording stays provenance-neutral
// (build instructions §2/§12) and the confirmation dialog matches the
// clarified business rule (build instruction §3).

const clientPath = fileURLToPath(new URL("../src/app/(app)/delivery-handoffs/DeliveryHandoffsClient.tsx", import.meta.url));
const source = readFileSync(clientPath, "utf-8");

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

const sourceFlat = normalizeWhitespace(source);

describe("staff Order handoff management — provenance-neutral existing-date wording", () => {
  it("never claims a known date came from the customer/portal — the old 'Reeds ontvangen' wording is gone", () => {
    expect(sourceFlat).not.toContain("Reeds ontvangen");
    expect(sourceFlat).not.toMatch(/door de klant doorgegeven/i);
    expect(sourceFlat).not.toMatch(/door klant doorgegeven/i);
    expect(sourceFlat).not.toMatch(/klant heeft.*gekozen/i);
  });

  it("shows the provenance-neutral 'reeds bekend' phrasing for an existing date, with the actual date rendered via the shared Dutch formatter", () => {
    expect(sourceFlat).toContain("Reeds bekend");
    expect(source).toContain("formatDateLong(result.requestedDeliveryDate)");
  });

  it("shows the confirmation prompt with provenance-neutral wording ('geregistreerd', never implying customer-portal origin) and the required two actions", () => {
    expect(sourceFlat).toContain("Gewenste leverdatum al bekend");
    expect(sourceFlat).toContain("geregistreerd");
    expect(sourceFlat).not.toMatch(/door de klant doorgegeven/i);
    expect(sourceFlat).toContain("Annuleren");
    expect(sourceFlat).toContain("Toch nieuwe link maken");
    expect(source).toContain("formatDateLong(confirmDialog.requestedDeliveryDate)");
  });

  it("the confirmation flag is sent only on the explicit confirm path, never on the initial search-result create click", () => {
    // The initial per-row "Leverdatumlink aanmaken" button calls
    // handleCreateOrder(result) with no second argument — only the
    // confirmation dialog's own "Toch nieuwe link maken" button passes
    // `true`.
    expect(source).toContain("onClick={() => handleCreateOrder(result)}");
    expect(source).toContain("void handleCreateOrder(result, true)");
  });

  it("the create request only sends confirmExistingRequestedDeliveryDate when actually confirming — never unconditionally", () => {
    const bodyBuildSite = source.slice(source.indexOf("async function handleCreateOrder"), source.indexOf("async function handleRegenerate"));
    expect(bodyBuildSite).toContain("confirmExisting ?");
  });
});
