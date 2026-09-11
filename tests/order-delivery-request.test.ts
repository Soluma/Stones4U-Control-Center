import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Phase 6AI — the customer fulfillment-date request flow.
//
// Source-text assertions, the same technique the rest of this repo's
// copy/structure tests use (there is no React render pipeline here); the
// decision behaviour itself is covered at the unit level in
// tests/delivery-request-decision.test.ts, and the live end-to-end behaviour
// was proven on staging.

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf-8");

const service = read("../src/modules/delivery/order-delivery-request.service.ts");
const form = read("../src/app/delivery/[token]/OrderDeliveryDateForm.tsx");
const page = read("../src/app/delivery/[token]/page.tsx");
const submitRoute = read("../src/app/api/delivery/[token]/route.ts");
const requestRoute = read("../src/app/api/delivery-handoffs/order/request/route.ts");

describe("createOrderDeliveryDateHandoffIfEligible — one canonical path", () => {
  it("runs the real decision engine rather than its own eligibility rules", () => {
    expect(service).toContain("evaluateDeliveryRequestDecision");
    expect(service).toContain("deliveryPolicyForPaymentPolicy");
    expect(service).toContain("getOrderForHandoff");
    // No second opinion about who may be asked.
    expect(service).not.toMatch(/fullyPaid\s*&&/);
    expect(service).not.toContain("hasRequestedDeliveryDateAlready ?");
  });

  it("creates only on a positive decision", () => {
    expect(service).toContain("if (!evaluation.decision.shouldRequest)");
    expect(service).toContain('return { outcome: "NOT_ELIGIBLE", evaluation };');
  });

  it("is idempotent — an existing handoff is reused, never duplicated", () => {
    expect(service).toContain("prisma.deliveryDateHandoff.findUnique");
    expect(service).toContain("sourceSystem_externalId");
    expect(service).toContain('return { outcome: "REUSED"');
    // Reuse must not mint a new token, which would invalidate the
    // customer's existing link.
    expect(service).toMatch(/outcome: "REUSED".*rawToken: null/s);
  });

  it("creates nothing customer-facing beyond the handoff", () => {
    for (const forbidden of ["sendMail", "nodemailer", "outbox", "webhookSubscriptionCreate", "notify"]) {
      expect(service.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("the staff route asks the same service the automation will", () => {
    expect(requestRoute).toContain("createOrderDeliveryDateHandoffIfEligible");
    // An ineligible Order is an answer, not an error.
    expect(requestRoute).toContain('outcome: result.outcome');
    expect(requestRoute).toContain("REASON_COPY");
  });

  it("staff never see a raw decision enum", () => {
    for (const reason of [
      "WAITING_FOR_PAYMENT",
      "ALREADY_HAS_REQUESTED_DELIVERY_DATE",
      "NOT_A_DELIVERY_ORDER",
      "INSUFFICIENT_CLASSIFICATION",
    ]) {
      expect(requestRoute).toContain(`${reason}:`);
    }
  });
});

describe("mode resolution — server-side, live, never client-supplied", () => {
  it("the public page re-resolves the mode from the Order", () => {
    expect(page).toContain("resolveCustomerFacingModeForHandoff");
    // The mode reaches the form as a server-computed prop.
    expect(page).toContain("mode={mode}");
  });

  it("an Order that no longer qualifies gets a safe non-form state", () => {
    expect(page).toContain("Dit verzoek is niet meer van toepassing");
    expect(page).toMatch(/if \(!mode\) \{/);
  });

  it("the resolver fails closed for cancelled, non-customer-facing and unreadable Orders", () => {
    expect(service).toContain("if (!order || order.isCancelled) return null;");
    expect(service).toContain("isCustomerFacingMode(mode) ? mode : null");
    // Never throws into the customer's page render.
    expect(service).toContain("delivery_handoff_mode_resolution_failed");
  });

  it("only DELIVERY and CUSTOMER_PICKUP are customer-facing", () => {
    expect(service).toMatch(/CUSTOMER_FACING_MODES[\s\S]{0,120}"DELIVERY",\s*\n\s*"CUSTOMER_PICKUP",/);
  });

  it("the submit route re-verifies the mode before writing anything", () => {
    expect(submitRoute).toContain("resolveCustomerFacingModeForHandoff");
    expect(submitRoute).toMatch(/if \(!mode\)[\s\S]{0,200}status: 409/);
  });
});

describe("delivery vs pickup customer copy", () => {
  it("delivery asks the delivery question", () => {
    expect(form).toContain("Wanneer mogen we langskomen?");
    expect(form).toContain("Gewenste bezorgdatum");
    expect(form).toContain("Opmerking voor de levering (optioneel)");
    expect(form).toContain("Ja, de afleverlocatie is bereikbaar met een grote vrachtwagen.");
  });

  it("pickup asks the pickup question", () => {
    expect(form).toContain("Wanneer wilt u uw bestelling ophalen?");
    expect(form).toContain("Gewenste afhaaldatum");
    expect(form).toContain("Opmerking voor het afhalen (optioneel)");
    expect(form).toContain("Afhaalmoment doorgeven");
  });

  it("the truck question is delivery-only, by data not by styling", () => {
    // The two copy blocks differ in exactly one behavioural flag.
    expect(form).toContain("showTruckQuestion: true");
    expect(form).toContain("showTruckQuestion: false");
    const deliveryBlock = form.slice(form.indexOf("  DELIVERY: {"), form.indexOf("  CUSTOMER_PICKUP: {"));
    const pickupBlock = form.slice(form.indexOf("  CUSTOMER_PICKUP: {"), form.indexOf("} as const;"));
    expect(deliveryBlock).toContain("showTruckQuestion: true");
    expect(pickupBlock).toContain("showTruckQuestion: false");
    expect(form).toContain("{copy.showTruckQuestion && (");
  });

  it("a pickup submission omits the truck field rather than sending false", () => {
    expect(form).toContain("...(copy.showTruckQuestion ? { largeTruckAccessConfirmed } : {})");
    // And the server drops it even if a crafted request supplies one.
    expect(submitRoute).toContain('mode === "DELIVERY" ? body.largeTruckAccessConfirmed : undefined');
  });

  it("neither mode mentions invoice or payment — this is a post-payment flow", () => {
    expect(form).not.toMatch(/\bfactuur\b/i);
    expect(form).not.toMatch(/\bbetaling\b/i);
  });

  it("both modes share one date field and one storage key", () => {
    // Build instruction §10 — no requested_pickup_date, no second input.
    expect(form).not.toContain("requestedPickupDate");
    expect(form).not.toContain("requested_pickup_date");
    expect((form.match(/id="requestedDeliveryDate"/g) ?? []).length).toBe(1);
  });
});
