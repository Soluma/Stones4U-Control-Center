import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Phase 6D — build instruction §14 asks for tests proving the public POST
// route's server-side type dispatch (Draft handoff → Draft service only,
// Order handoff → Order service only, no client-supplied type/GID can
// influence it, unsupported type fails closed, no GID sniffing). This repo
// has no route-level HTTP test pipeline (confirmed exhaustively during
// Phase 6C — vitest.config.mts runs environment: "node" with no
// supertest/msw, and no .test.ts anywhere invokes a route handler
// directly), so — same technique as tests/delivery-page-copy.test.ts for
// the page's customer-facing copy — this asserts directly against the
// route's own source text. The actual submission behavior each branch
// dispatches to (persist/mirror/status/Activity semantics, cancelled-Order
// handling, etc.) is already fully covered at the service layer in
// tests/delivery-handoff.test.ts and is untouched by this file.

const routePath = fileURLToPath(new URL("../src/app/api/delivery/[token]/route.ts", import.meta.url));
const routeSource = readFileSync(routePath, "utf-8");

describe("public POST /api/delivery/[token] — server-side type dispatch", () => {
  it("reads the request body for exactly one field — no client-suppliable type, GID, shop, redirect, or payment field is ever read", () => {
    expect(routeSource).toContain("body.requestedDeliveryDate");
    for (const forbiddenField of [
      "body.commerceObjectType",
      "body.type",
      "body.orderGid",
      "body.draftOrderGid",
      "body.shopifyOrderGid",
      "body.shopifyDraftOrderGid",
      "body.shopDomain",
      "body.shop",
      "body.redirectUrl",
      "body.paymentTarget",
      "body.paymentProvider",
    ]) {
      expect(routeSource).not.toContain(forbiddenField);
    }
  });

  it("dispatches exclusively on the persisted handoff.commerceObjectType — never a GID string sniff", () => {
    expect(routeSource).toContain('handoff.commerceObjectType === "SHOPIFY_DRAFT_ORDER"');
    expect(routeSource).toContain('handoff.commerceObjectType === "SHOPIFY_ORDER"');
    expect(routeSource).not.toMatch(/gid:\/\/shopify/i);
    expect(routeSource).not.toMatch(/\.startsWith\(.*[Gg]id/);
    expect(routeSource).not.toMatch(/\.includes\(.*[Gg]id/);
  });

  it("the SHOPIFY_DRAFT_ORDER branch calls only the Draft submission service", () => {
    const draftBranch = routeSource.slice(
      routeSource.indexOf('handoff.commerceObjectType === "SHOPIFY_DRAFT_ORDER"'),
      routeSource.indexOf('handoff.commerceObjectType === "SHOPIFY_ORDER"'),
    );
    expect(draftBranch).toContain("submitRequestedDeliveryDate(handoff");
    expect(draftBranch).not.toContain("submitRequestedDeliveryDateForOrder(handoff");
    expect(draftBranch).toContain('outcome: "REDIRECT"');
  });

  it("the SHOPIFY_ORDER branch calls only the Order submission service", () => {
    const orderBranch = routeSource.slice(routeSource.indexOf('handoff.commerceObjectType === "SHOPIFY_ORDER"'));
    expect(orderBranch).toContain("submitRequestedDeliveryDateForOrder(handoff");
    // Not a substring collision risk: "submitRequestedDeliveryDate(handoff"
    // is not a literal substring of "submitRequestedDeliveryDateForOrder(handoff"
    // ("Date" is immediately followed by "ForOrder(", never "(", in the real call).
    expect(orderBranch).not.toContain("submitRequestedDeliveryDate(handoff");
    expect(orderBranch).toContain('outcome: "COMPLETED"');
  });

  it("an unrecognized commerceObjectType fails closed with a generic error — never a silent fallback to either service", () => {
    const afterBothBranches = routeSource.slice(routeSource.lastIndexOf('outcome: "COMPLETED"'));
    expect(afterBothBranches).toContain("delivery_handoff_unsupported_commerce_object_type");
    expect(afterBothBranches).toMatch(/status:\s*500/);
    expect(afterBothBranches).not.toContain("submitRequestedDeliveryDate(handoff");
    expect(afterBothBranches).not.toContain("submitRequestedDeliveryDateForOrder(handoff");
  });

  it("never leaks internal error detail (no stack trace), and every 500 response uses a fixed generic message rather than the raw caught error", () => {
    expect(routeSource).not.toMatch(/error\.stack/);
    const status500Count = (routeSource.match(/status:\s*500/g) ?? []).length;
    const genericMessageCount = (routeSource.match(/Er ging iets mis\. Probeer het opnieuw\./g) ?? []).length;
    expect(status500Count).toBeGreaterThan(0);
    expect(genericMessageCount).toBe(status500Count);
  });
});
