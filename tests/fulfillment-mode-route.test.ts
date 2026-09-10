import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Phase 6L — same source-text technique as
// tests/delivery-handoffs-order-route.test.ts (this repo has no route-level
// HTTP test pipeline). Confirms the auth split, the strict write contract,
// and that no client-supplied state can reach the service.

const routeSource = readFileSync(
  fileURLToPath(new URL("../src/app/api/delivery-handoffs/order/fulfillment-mode/route.ts", import.meta.url)),
  "utf-8",
);
const dialogSource = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/delivery-handoffs/FulfillmentModeDialog.tsx", import.meta.url)),
  "utf-8",
);
const clientSource = readFileSync(
  fileURLToPath(new URL("../src/app/(app)/delivery-handoffs/DeliveryHandoffsClient.tsx", import.meta.url)),
  "utf-8",
);

describe("fulfillment-mode route — auth", () => {
  it("reads require a signed-in user; writes require ADMIN/AGENT write access", () => {
    const getBlock = routeSource.slice(routeSource.indexOf("export async function GET"), routeSource.indexOf("export async function POST"));
    const postBlock = routeSource.slice(routeSource.indexOf("export async function POST"));
    expect(getBlock).toContain("requireUser()");
    expect(postBlock).toContain("requireWriteAccess()");
    // The write path must not settle for a plain signed-in user.
    expect(postBlock).not.toContain("requireUser()");
  });

  it("authorization is server-derived — the actor id comes from the guard, never from the body", () => {
    expect(routeSource).toContain("actorId: actor.id");
    expect(routeSource).not.toContain("input.actorId");
    expect(routeSource).not.toContain("body.actorId");
  });
});

describe("fulfillment-mode route — strict write contract", () => {
  it("accepts only canonical modes (or null), sourced from the contract's own list", () => {
    expect(routeSource).toContain("z.enum(EXPLICIT_FULFILLMENT_MODES)");
    expect(routeSource).toContain(".nullable()");
  });

  it("never accepts client-supplied current/native/resolved state", () => {
    for (const forbidden of [
      "input.nativeFulfillmentMode",
      "input.explicitFulfillmentMode",
      "input.resolution",
      "input.previousMode",
      "input.orderName",
      "input.shopDomain",
      "input.isCancelled",
    ]) {
      expect(routeSource).not.toContain(forbidden);
    }
  });

  it("maps the confirmation error to a typed 409 carrying only server-read state", () => {
    expect(routeSource).toContain("instanceof FulfillmentModeConfirmationRequiredError");
    expect(routeSource).toContain('code: "FULFILLMENT_MODE_CONFIRMATION_REQUIRED"');
    expect(routeSource).toMatch(/status:\s*409/);
    const branch = routeSource.slice(
      routeSource.indexOf("instanceof FulfillmentModeConfirmationRequiredError"),
      routeSource.indexOf("return toErrorResponse(error)"),
    );
    expect(branch).not.toMatch(/\.\.\.(error|input)/);
  });

  it("carries the state echo for a confirmed retry, and returns it on the 409", () => {
    expect(routeSource).toContain("expectedCurrentState:");
    expect(routeSource).toContain("currentStateToken: error.currentStateToken");
    // Echoed straight through to the service, which validates it against its
    // own fresh read — the route never interprets it.
    expect(routeSource).toContain("expectedCurrentState: input.expectedCurrentState");
  });

  it("sends no email and creates no handoff from this route", () => {
    for (const forbidden of ["sendMail", "sendEmail", "outbox", "createOrderDeliveryHandoff", "DELIVERY_DATE_REQUESTED"]) {
      expect(routeSource).not.toContain(forbidden);
    }
  });
});

describe("fulfillment-mode staff UI copy", () => {
  it("uses Dutch business labels rather than raw canonical values as the primary UX", () => {
    for (const label of ["Bezorgen", "Afhalen", "Afhaalpunt", "Winkelverkoop", "Geen fysieke levering", "Niet bepaald"]) {
      expect(dialogSource).toContain(label);
    }
  });

  it("shows the three classification fields staff need", () => {
    expect(dialogSource).toContain("Shopify-signaal");
    expect(dialogSource).toContain("Stones4U-keuze");
    expect(dialogSource).toContain("Effectieve classificatie");
  });

  it("offers a clear/reset action", () => {
    expect(dialogSource).toContain("Handmatige keuze verwijderen");
  });

  it("asks for confirmation with both the current and the new choice, and warns about later effect", () => {
    expect(dialogSource).toContain("Huidige keuze");
    expect(dialogSource).toContain("Nieuwe keuze");
    expect(dialogSource).toContain("Deze wijziging kan later invloed hebben op de automatische leveringscommunicatie.");
    expect(dialogSource).toContain("Wijziging bevestigen");
    expect(dialogSource).toContain("Annuleren");
  });

  it("treats an explicit-over-untrusted-native mismatch as informational, not as an error", () => {
    expect(dialogSource).toContain("Tijdens de overgang is dit normaal");
    expect(dialogSource).toContain("EXPLICIT_OVERRODE_NATIVE");
  });

  it("warns prominently on a genuine contradiction and says automation stays blocked", () => {
    expect(dialogSource).toContain("spreken elkaar tegen");
    expect(dialogSource).toContain("Automatische leveringscommunicatie blijft geblokkeerd.");
  });

  it("never implies delivery automation is currently active", () => {
    expect(dialogSource).toContain("Automatische leveringscommunicatie is nog niet actief");
    for (const forbidden of ["wordt verstuurd", "versturen we", "ontvangt de klant"]) {
      expect(dialogSource).not.toContain(forbidden);
    }
  });

  it("states that invoicing is unaffected", () => {
    expect(dialogSource).toContain("Dit verandert niets aan de facturatie van Shopify.");
  });

  it("is reachable from the existing staff Order workflow rather than a separate page", () => {
    expect(clientSource).toContain("FulfillmentModeDialog");
    expect(clientSource).toContain("Afhandeling");
    // Write capability is passed down from the server-rendered page, not
    // decided in the browser.
    expect(clientSource).toContain("canWrite={canCreate}");
  });
});
