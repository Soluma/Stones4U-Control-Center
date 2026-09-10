import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Phase 6V — locks in the authoritative Stones4U customer journey after a
// wrong turn in 6T/6U.
//
// THE CORRECT FLOW IS PAYMENT-FIRST:
//
//   quote / Draft Order
//     -> customer goes through the existing checkout / invoice / payment path
//     -> Shopify creates the REAL Order
//     -> only THEN is the customer asked for delivery logistics
//     -> the answers are written to the REAL Order
//
// 6T moved the logistics questions in front of payment by putting them on the
// Draft form, and 6U then built a Draft->Order transfer to carry the answers
// across. Both were solving a problem that only existed because the questions
// were asked too early. Both were reverted.
//
// These assertions are deliberately narrow and structural: they exist so a
// future change that re-introduces pre-payment logistics collection fails
// loudly here rather than shipping.

const url = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => readFileSync(url(p), "utf-8");

const orderForm = read("../src/app/delivery/[token]/OrderDeliveryDateForm.tsx");
const draftForm = read("../src/app/delivery/[token]/DeliveryDateForm.tsx");
const page = read("../src/app/delivery/[token]/page.tsx");
const service = read("../src/modules/delivery/delivery-handoff.service.ts");
const decision = read("../src/modules/delivery/delivery-request-decision.ts");
const orderMirror = read("../src/integrations/shopify/order-mirror.ts");
const metafields = read("../src/integrations/shopify/order-logistics-metafields.ts");

describe("payment-first architecture — the REAL Order collects delivery logistics", () => {
  it("the Order form asks all three questions", () => {
    expect(orderForm).toContain("Ja, de afleverlocatie is bereikbaar met een grote vrachtwagen.");
    expect(orderForm).toContain("Opmerking voor de levering (optioneel)");
    expect(orderForm).toContain('label="Gewenste leverdatum"');
    expect(orderForm).toContain("Wij leveren van maandag t/m vrijdag");
  });

  it("the Order form prefills from the persisted handoff", () => {
    expect(orderForm).toContain('useState(currentDeliveryComment ?? "")');
    expect(orderForm).toContain("currentLargeTruckAccessConfirmed === true");
    expect(page).toContain("currentDeliveryComment={handoff.deliveryComment}");
  });

  it("the Order submission mirrors logistics to the real Order's metafields", () => {
    expect(service).toContain("mirrorOrderLogisticsMetafields");
    expect(metafields).toContain("delivery_comment");
    expect(metafields).toContain("large_truck_access_confirmed");
    expect(metafields).toContain("metafieldsSet");
  });

  it("the requested date keeps its own independent customAttribute path", () => {
    expect(orderMirror).toContain("requested_delivery_date");
    // The metafield writer may explain the split in prose, but must never
    // name the date key in an actual metafield operation.
    expect(metafields).not.toMatch(/key:\s*["']?requested_delivery_date/);
    expect(metafields).not.toContain("REQUESTED_DELIVERY_DATE_");
  });
});

describe("payment-first architecture — the Draft stays a pre-payment, legacy flow", () => {
  it("the legacy Draft form asks ONLY for a date — logistics belong after payment", () => {
    expect(draftForm).toContain('label="Gewenste leverdatum"');
    // The two Order-only questions must not appear before payment.
    expect(draftForm).not.toContain("grote vrachtwagen");
    expect(draftForm).not.toContain("Opmerking voor de levering");
    expect(draftForm).not.toContain("largeTruckAccessConfirmed");
    expect(draftForm).not.toContain("deliveryComment");
  });

  it("the Draft POST body carries only the date", () => {
    const body = draftForm.match(/body:\s*JSON\.stringify\(\{([^}]*)\}\)/)![1]!;
    const fields = body.split(",").map((f) => f.trim()).filter(Boolean);
    expect(fields).toEqual(["requestedDeliveryDate: date"]);
  });

  it("the Draft keeps its existing invoice/payment redirect", () => {
    expect(draftForm).toContain("window.location.href = body.redirectUrl");
    expect(draftForm).toContain("Leverdatum opslaan en verder naar factuur");
  });

  it("a staff-agreed requested_delivery_date may still ride along on the Draft", () => {
    // The one intentional pre-payment exception (build instruction §5): the
    // date can be known at quote time and propagates as a customAttribute.
    expect(service).toContain("submitRequestedDeliveryDate");
    expect(orderMirror).toContain("requested_delivery_date");
  });

  it("the Draft still validates dates against the canonical business-day policy", () => {
    const draftFn = service.slice(
      service.indexOf("export async function submitRequestedDeliveryDate("),
      service.indexOf("export async function submitRequestedDeliveryDateForOrder("),
    );
    expect(draftFn).toContain("validateRequestedDeliveryDate");
  });
});

describe("payment-first architecture — no pre-payment logistics machinery survives", () => {
  it("no Draft->Order logistics transfer service exists", () => {
    expect(existsSync(url("../src/modules/delivery/draft-order-logistics-transfer.ts"))).toBe(false);
    expect(existsSync(url("../src/integrations/shopify/draft-order-completion.ts"))).toBe(false);
  });

  it("nothing reads DraftOrder.order to carry logistics across", () => {
    for (const source of [service, metafields, page]) {
      expect(source).not.toContain("getDraftOrderCompletion");
      expect(source).not.toContain("transferDraftLogisticsToOrder");
      expect(source).not.toContain("sweepDraftLogisticsTransfers");
    }
  });

  it("no logistics-transfer audit action exists", () => {
    expect(read("../src/platform/audit/audit.ts")).not.toContain("logistics_transferred");
  });

  it("no correlation marker is written to Drafts", () => {
    for (const source of [service, read("../src/integrations/shopify/draft-order-mirror.ts")]) {
      expect(source).not.toContain("stones4u_delivery_handoff_id");
      expect(source).not.toContain("stones4u_delivery_context_id");
    }
  });
});

describe("payment-first architecture — automation stays switched off", () => {
  it("READY_FOR_DELIVERY_REQUEST remains unreachable", () => {
    expect(decision).toMatch(/function hasTrustworthyDeliveryOrderClassification\(\): boolean \{\s*return false;/);
  });

  it("no delivery email sender or notification outbox exists", () => {
    for (const source of [service, decision, orderForm, draftForm]) {
      expect(source).not.toMatch(/nodemailer|sendMail|Mail\.Send|outbox/i);
    }
  });

  it("no code registers a Shopify webhook subscription", () => {
    for (const source of [service, decision, metafields, orderMirror]) {
      expect(source).not.toContain("webhookSubscriptionCreate");
      expect(source).not.toContain("webhookSubscriptionDelete");
    }
  });
});
