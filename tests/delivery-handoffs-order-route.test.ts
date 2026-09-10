import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Phase 6E final review — same source-text technique as
// tests/delivery-route-dispatch.test.ts (this repo has no route-level HTTP
// test pipeline). Confirms the staff Order-creation route's confirmation
// flow: accepts only orderGid + a narrow boolean flag, maps
// ExistingRequestedDeliveryDateError to a typed 409 carrying only safe
// data, and never lets the confirmation flag reach anything but that one
// call.

const routePath = fileURLToPath(new URL("../src/app/api/delivery-handoffs/order/route.ts", import.meta.url));
const routeSource = readFileSync(routePath, "utf-8");

describe("POST /api/delivery-handoffs/order — confirmation flow (build instructions §4, §6)", () => {
  it("accepts only orderGid and the narrow confirmation flag — no publicReference/customerProfileId/commerceObjectType/shop field", () => {
    expect(routeSource).toContain("orderGid:");
    expect(routeSource).toContain("confirmExistingRequestedDeliveryDate:");
    for (const forbiddenField of [
      "input.publicReference",
      "input.customerProfileId",
      "input.commerceObjectType",
      "input.shopDomain",
      "input.requestedDeliveryDate",
    ]) {
      expect(routeSource).not.toContain(forbiddenField);
    }
  });

  it("maps ExistingRequestedDeliveryDateError to a 409 with exactly the typed shape — a fixed code and the date value, nothing else", () => {
    expect(routeSource).toContain("instanceof ExistingRequestedDeliveryDateError");
    expect(routeSource).toContain('code: "EXISTING_REQUESTED_DELIVERY_DATE"');
    expect(routeSource).toMatch(/status:\s*409/);
    // The 409 branch constructs its own literal object — it does not
    // spread the caught error or forward anything beyond the one field.
    const branch = routeSource.slice(
      routeSource.indexOf("instanceof ExistingRequestedDeliveryDateError"),
      routeSource.indexOf("return toErrorResponse(error)"),
    );
    expect(branch).not.toMatch(/\.\.\.(error|input)/);
  });

  it("write access is required before anything else — no anonymous path to this route", () => {
    expect(routeSource).toContain("requireWriteAccess()");
  });
});
