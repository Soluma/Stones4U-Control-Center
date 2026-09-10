import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6R — writer-level tests against a mocked fetch, matching the
// technique used for the other Shopify writers in this repo.

const ENV_KEYS = [
  "SHOPIFY_SHOP_DOMAIN",
  "SHOPIFY_API_VERSION",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS",
] as const;

const ORDER_GID = "gid://shopify/Order/9001";
const NS = "stones4u";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const tokenResponse = () => jsonResponse({ access_token: "tok_123", expires_in: 3600 });
const shopIdentityResponse = (domain: string) => jsonResponse({ data: { shop: { myshopifyDomain: domain } } });

/** The scoped two-key read this module performs. */
function currentResponse(comment: string | null, truck: string | null) {
  return jsonResponse({
    data: {
      order: {
        id: ORDER_GID,
        comment: comment === null ? null : { id: "gid://shopify/Metafield/1", value: comment, compareDigest: "digest-comment" },
        truck: truck === null ? null : { id: "gid://shopify/Metafield/2", value: truck, compareDigest: "digest-truck" },
      },
    },
  });
}
const setResponse = (userErrors: unknown[] = []) =>
  jsonResponse({ data: { metafieldsSet: { metafields: [], userErrors } } });
const deleteResponse = (userErrors: unknown[] = []) =>
  jsonResponse({ data: { metafieldsDelete: { deletedMetafields: [{ namespace: NS, key: "delivery_comment" }], userErrors } } });

function setAllowedEnv() {
  process.env.SHOPIFY_SHOP_DOMAIN = "stones4u-dev.myshopify.com";
  process.env.SHOPIFY_API_VERSION = "2026-07";
  process.env.SHOPIFY_CLIENT_ID = "test-client-id";
  process.env.SHOPIFY_CLIENT_SECRET = "test-client-secret";
  process.env.SHOPIFY_WRITE_ALLOWED_MYSHOPIFY_DOMAINS = "stones4u-dev.myshopify.com";
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, index: number) {
  return JSON.parse(fetchMock.mock.calls[index]![1].body as string);
}
/** Every GraphQL mutation body sent during a call. The OAuth token request
 * is form-encoded rather than JSON, so parsing is best-effort. */
function mutationBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .map((c) => {
      try {
        return JSON.parse(c[1].body as string);
      } catch {
        return null;
      }
    })
    .filter((b) => b && typeof b.query === "string" && /^\s*mutation/m.test(b.query));
}

describe("mirrorOrderLogisticsMetafields", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
  });
  afterEach(() => vi.unstubAllGlobals());

  it("does nothing at all — not even a read — when both fields are PRESERVE", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorOrderLogisticsMetafields } = await import("@/integrations/shopify/order-logistics-metafields");
    const result = await mirrorOrderLogisticsMetafields(ORDER_GID, {
      deliveryComment: { action: "PRESERVE" },
      largeTruckAccessConfirmed: { action: "PRESERVE" },
    });

    expect(result.noop).toBe(true);
    expect(result.written).toEqual([]);
    // No token request, no shop-identity check, no read, no mutation.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never writes when the shop is not on the write allowlist", async () => {
    setAllowedEnv();
    process.env.SHOPIFY_SHOP_DOMAIN = "stones4u.myshopify.com";
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(shopIdentityResponse("stones4u.myshopify.com"));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorOrderLogisticsMetafields } = await import("@/integrations/shopify/order-logistics-metafields");
    await expect(
      mirrorOrderLogisticsMetafields(ORDER_GID, { largeTruckAccessConfirmed: { action: "SET", value: true } }),
    ).rejects.toThrow(/shop identity mismatch/i);
    // Token + identity only — the Order was never read.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("writes the comment to stones4u.delivery_comment as multi_line_text_field", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(currentResponse(null, null))
      .mockResolvedValueOnce(setResponse())
      .mockResolvedValueOnce(currentResponse("Poort aan de zijkant.", null));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorOrderLogisticsMetafields } = await import("@/integrations/shopify/order-logistics-metafields");
    const result = await mirrorOrderLogisticsMetafields(ORDER_GID, {
      deliveryComment: { action: "SET", value: "Poort aan de zijkant." },
    });

    expect(result.written).toEqual(["delivery_comment"]);
    const sent = mutationBodies(fetchMock)[0]!.variables.metafields;
    expect(sent).toEqual([
      {
        ownerId: ORDER_GID,
        namespace: NS,
        key: "delivery_comment",
        type: "multi_line_text_field",
        value: "Poort aan de zijkant.",
      },
    ]);
  });

  it("writes truck access true as a boolean metafield", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(currentResponse(null, null))
      .mockResolvedValueOnce(setResponse())
      .mockResolvedValueOnce(currentResponse(null, "true"));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorOrderLogisticsMetafields } = await import("@/integrations/shopify/order-logistics-metafields");
    await mirrorOrderLogisticsMetafields(ORDER_GID, { largeTruckAccessConfirmed: { action: "SET", value: true } });

    const sent = mutationBodies(fetchMock)[0]!.variables.metafields[0];
    expect(sent).toMatchObject({ key: "large_truck_access_confirmed", type: "boolean", value: "true" });
  });

  it("writes truck access false as boolean false — never omitted, never 'inaccessible'", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(currentResponse(null, null))
      .mockResolvedValueOnce(setResponse())
      .mockResolvedValueOnce(currentResponse(null, "false"));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorOrderLogisticsMetafields } = await import("@/integrations/shopify/order-logistics-metafields");
    await mirrorOrderLogisticsMetafields(ORDER_GID, { largeTruckAccessConfirmed: { action: "SET", value: false } });

    const sent = mutationBodies(fetchMock)[0]!.variables.metafields[0];
    expect(sent).toMatchObject({ key: "large_truck_access_confirmed", type: "boolean", value: "false" });
  });

  it("sends compareDigest when updating an existing value, so a newer concurrent write is not clobbered", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(currentResponse("oude opmerking", "false"))
      .mockResolvedValueOnce(setResponse())
      .mockResolvedValueOnce(currentResponse("nieuwe opmerking", "true"));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorOrderLogisticsMetafields } = await import("@/integrations/shopify/order-logistics-metafields");
    await mirrorOrderLogisticsMetafields(ORDER_GID, {
      deliveryComment: { action: "SET", value: "nieuwe opmerking" },
      largeTruckAccessConfirmed: { action: "SET", value: true },
    });

    const sent = mutationBodies(fetchMock)[0]!.variables.metafields;
    expect(sent.find((m: { key: string }) => m.key === "delivery_comment").compareDigest).toBe("digest-comment");
    expect(sent.find((m: { key: string }) => m.key === "large_truck_access_confirmed").compareDigest).toBe("digest-truck");
  });

  it("omits compareDigest when creating a metafield that does not exist yet", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(currentResponse(null, null))
      .mockResolvedValueOnce(setResponse())
      .mockResolvedValueOnce(currentResponse(null, "true"));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorOrderLogisticsMetafields } = await import("@/integrations/shopify/order-logistics-metafields");
    await mirrorOrderLogisticsMetafields(ORDER_GID, { largeTruckAccessConfirmed: { action: "SET", value: true } });

    expect(mutationBodies(fetchMock)[0]!.variables.metafields[0]).not.toHaveProperty("compareDigest");
  });

  it("clears a remark by deleting the metafield, not by writing an empty string", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(currentResponse("bestaande opmerking", null))
      .mockResolvedValueOnce(deleteResponse())
      .mockResolvedValueOnce(currentResponse(null, null));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorOrderLogisticsMetafields } = await import("@/integrations/shopify/order-logistics-metafields");
    const result = await mirrorOrderLogisticsMetafields(ORDER_GID, {
      deliveryComment: { action: "SET", value: null },
    });

    expect(result.deleted).toEqual(["delivery_comment"]);
    const bodies = mutationBodies(fetchMock);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.query).toMatch(/metafieldsDelete/);
    expect(bodies[0]!.query).not.toMatch(/metafieldsSet/);
    expect(bodies[0]!.variables.metafields).toEqual([{ ownerId: ORDER_GID, namespace: NS, key: "delivery_comment" }]);
  });

  it("skips the delete entirely when the remark is already absent", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(currentResponse(null, null))
      .mockResolvedValueOnce(currentResponse(null, null));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorOrderLogisticsMetafields } = await import("@/integrations/shopify/order-logistics-metafields");
    const result = await mirrorOrderLogisticsMetafields(ORDER_GID, { deliveryComment: { action: "SET", value: null } });

    expect(result.deleted).toEqual([]);
    expect(mutationBodies(fetchMock)).toHaveLength(0);
  });

  it("only ever names its own two keys — no unrelated metafield is read or written", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(currentResponse(null, null))
      .mockResolvedValueOnce(setResponse())
      .mockResolvedValueOnce(currentResponse("x", "true"));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorOrderLogisticsMetafields } = await import("@/integrations/shopify/order-logistics-metafields");
    await mirrorOrderLogisticsMetafields(ORDER_GID, {
      deliveryComment: { action: "SET", value: "x" },
      largeTruckAccessConfirmed: { action: "SET", value: true },
    });

    // The read is key-scoped, never a blanket metafields(first: n) enumeration.
    const readQuery = bodyOf(fetchMock, 2).query;
    expect(readQuery).toMatch(/metafield\(namespace/);
    expect(readQuery).not.toMatch(/metafields\(first/);
    // And every namespace mentioned in a mutation is ours.
    for (const body of mutationBodies(fetchMock)) {
      for (const m of body.variables.metafields) expect(m.namespace).toBe(NS);
    }
  });

  it("treats metafieldsSet userErrors as a failure, never as success", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(currentResponse(null, null))
      .mockResolvedValueOnce(setResponse([{ field: ["metafields"], message: "stale digest", code: "STALE_OBJECT" }]));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorOrderLogisticsMetafields } = await import("@/integrations/shopify/order-logistics-metafields");
    await expect(
      mirrorOrderLogisticsMetafields(ORDER_GID, { largeTruckAccessConfirmed: { action: "SET", value: true } }),
    ).rejects.toThrow(/metafieldsSet gaf userErrors/);
  });

  it("treats metafieldsDelete userErrors as a failure", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(currentResponse("bestaand", null))
      .mockResolvedValueOnce(deleteResponse([{ field: null, message: "nope" }]));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorOrderLogisticsMetafields } = await import("@/integrations/shopify/order-logistics-metafields");
    await expect(
      mirrorOrderLogisticsMetafields(ORDER_GID, { deliveryComment: { action: "SET", value: null } }),
    ).rejects.toThrow(/metafieldsDelete gaf userErrors/);
  });

  it("fails when the post-write verification does not match what was requested", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(currentResponse(null, null))
      .mockResolvedValueOnce(setResponse())
      // Shopify reported no errors, but stored something else.
      .mockResolvedValueOnce(currentResponse(null, "false"));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorOrderLogisticsMetafields } = await import("@/integrations/shopify/order-logistics-metafields");
    await expect(
      mirrorOrderLogisticsMetafields(ORDER_GID, { largeTruckAccessConfirmed: { action: "SET", value: true } }),
    ).rejects.toThrow(/Verificatie na metafield-schrijfactie mislukt/);
  });

  it("fails when a cleared remark is somehow still present afterwards", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(currentResponse("bestaand", null))
      .mockResolvedValueOnce(deleteResponse())
      .mockResolvedValueOnce(currentResponse("bestaand", null));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorOrderLogisticsMetafields } = await import("@/integrations/shopify/order-logistics-metafields");
    await expect(
      mirrorOrderLogisticsMetafields(ORDER_GID, { deliveryComment: { action: "SET", value: null } }),
    ).rejects.toThrow(/Verificatie na metafield-schrijfactie mislukt/);
  });

  it("never touches requested_delivery_date — the only mutations it can issue are the two metafield ones", async () => {
    setAllowedEnv();
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(shopIdentityResponse("stones4u-dev.myshopify.com"))
      .mockResolvedValueOnce(currentResponse("oud", "false"))
      .mockResolvedValueOnce(setResponse())
      .mockResolvedValueOnce(currentResponse("nieuw", "true"));
    vi.stubGlobal("fetch", fetchMock);

    const { mirrorOrderLogisticsMetafields } = await import("@/integrations/shopify/order-logistics-metafields");
    await mirrorOrderLogisticsMetafields(ORDER_GID, {
      deliveryComment: { action: "SET", value: "nieuw" },
      largeTruckAccessConfirmed: { action: "SET", value: true },
    });

    // Asserted on the operations actually sent, not on prose in comments.
    for (const body of mutationBodies(fetchMock)) {
      expect(body.query).toMatch(/metafieldsSet|metafieldsDelete/);
      expect(body.query).not.toMatch(/orderUpdate/);
      expect(JSON.stringify(body.variables)).not.toMatch(/requested_delivery_date|customAttributes/);
    }
  });
});
