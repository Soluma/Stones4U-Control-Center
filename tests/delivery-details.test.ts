import { describe, expect, it } from "vitest";
import {
  resolveDeliveryCommentPatch,
  resolveLargeTruckAccessPatch,
  formatLargeTruckAccess,
  DELIVERY_COMMENT_MAX_LENGTH,
} from "@/modules/delivery/delivery-details";

// Phase 6Q — the central distinction under test is "said nothing" vs "said
// empty". Collapsing the two would let a request that only carries a date
// wipe a customer's access instructions.
describe("resolveDeliveryCommentPatch — absent vs explicit", () => {
  it("an absent property preserves whatever is stored", () => {
    expect(resolveDeliveryCommentPatch(undefined)).toEqual({ ok: true, patch: { action: "PRESERVE" } });
  });

  it("an explicit null clears the stored comment", () => {
    expect(resolveDeliveryCommentPatch(null)).toEqual({ ok: true, patch: { action: "SET", value: null } });
  });

  it("an explicit empty string clears the stored comment", () => {
    expect(resolveDeliveryCommentPatch("")).toEqual({ ok: true, patch: { action: "SET", value: null } });
  });

  it("an explicit whitespace-only string clears the stored comment", () => {
    expect(resolveDeliveryCommentPatch("   ")).toEqual({ ok: true, patch: { action: "SET", value: null } });
    expect(resolveDeliveryCommentPatch("\n\t  \n")).toEqual({ ok: true, patch: { action: "SET", value: null } });
  });

  it("trims outer whitespace but keeps the text itself", () => {
    expect(resolveDeliveryCommentPatch("  graag bellen bij aankomst  ")).toEqual({
      ok: true,
      patch: { action: "SET", value: "graag bellen bij aankomst" },
    });
  });

  it("preserves internal line breaks", () => {
    const value = "Poort aan de zijkant.\nGraag bellen bij aankomst.";
    expect(resolveDeliveryCommentPatch(value)).toEqual({ ok: true, patch: { action: "SET", value } });
  });

  it("preserves Dutch and unicode characters", () => {
    const value = "Aflevering achterom — smalle straat, ± 3m. Bel a.u.b. vóór 9 uur. 🚚";
    expect(resolveDeliveryCommentPatch(value)).toEqual({ ok: true, patch: { action: "SET", value } });
  });

  it("accepts exactly the maximum length", () => {
    const value = "a".repeat(DELIVERY_COMMENT_MAX_LENGTH);
    expect(resolveDeliveryCommentPatch(value)).toEqual({ ok: true, patch: { action: "SET", value } });
  });

  it("rejects one character over the maximum", () => {
    const result = resolveDeliveryCommentPatch("a".repeat(DELIVERY_COMMENT_MAX_LENGTH + 1));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("500");
  });

  it("measures length after trimming, so surrounding whitespace cannot push a valid comment over", () => {
    const value = "a".repeat(DELIVERY_COMMENT_MAX_LENGTH);
    expect(resolveDeliveryCommentPatch(`   ${value}   `)).toEqual({ ok: true, patch: { action: "SET", value } });
  });

  it("keeps HTML-like text as literal characters — it is never parsed, only stored as text", () => {
    const value = '<script>alert("x")</script> & <b>vet</b>';
    expect(resolveDeliveryCommentPatch(value)).toEqual({ ok: true, patch: { action: "SET", value } });
  });

  it("rejects a non-string value rather than coercing it", () => {
    expect(resolveDeliveryCommentPatch(42 as unknown as string).ok).toBe(false);
    expect(resolveDeliveryCommentPatch({} as unknown as string).ok).toBe(false);
  });
});

describe("resolveLargeTruckAccessPatch — only a real boolean is an answer", () => {
  it("true is stored as confirmed", () => {
    expect(resolveLargeTruckAccessPatch(true)).toEqual({ action: "SET", value: true });
  });

  it("false is stored as NOT confirmed — an explicit answer, not an absence", () => {
    expect(resolveLargeTruckAccessPatch(false)).toEqual({ action: "SET", value: false });
  });

  it("an absent property preserves whatever is stored — never fabricates false", () => {
    expect(resolveLargeTruckAccessPatch(undefined)).toEqual({ action: "PRESERVE" });
  });

  it("null and non-boolean values preserve rather than overwrite", () => {
    for (const raw of [null, "true", "false", 1, 0, {}, []]) {
      expect(resolveLargeTruckAccessPatch(raw)).toEqual({ action: "PRESERVE" });
    }
  });
});

describe("formatLargeTruckAccess — false must never read as 'inaccessible'", () => {
  it("true renders as confirmed", () => {
    expect(formatLargeTruckAccess(true)).toBe("Bereikbaar met grote vrachtwagen: bevestigd");
  });

  it("false renders as NOT confirmed, not as inaccessible", () => {
    const text = formatLargeTruckAccess(false);
    expect(text).toBe("Bereikbaar met grote vrachtwagen: niet bevestigd");
    expect(text).not.toMatch(/onbereikbaar|niet bereikbaar|inaccessible/i);
  });

  it("historical null renders as unknown", () => {
    expect(formatLargeTruckAccess(null)).toBe("Bereikbaarheid grote vrachtwagen: onbekend");
    expect(formatLargeTruckAccess(undefined)).toBe("Bereikbaarheid grote vrachtwagen: onbekend");
  });

  it("the three states are all distinguishable from one another", () => {
    const rendered = [formatLargeTruckAccess(true), formatLargeTruckAccess(false), formatLargeTruckAccess(null)];
    expect(new Set(rendered).size).toBe(3);
  });
});
