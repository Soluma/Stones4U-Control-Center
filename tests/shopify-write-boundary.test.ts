import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Phase 6Y — structural proof that every Shopify mutation in this repo is
// behind assertShopifyWriteAllowed().
//
// This exists because of the Phase 6W incident: ad-hoc tooling wrote eight
// real Orders and two real Draft Orders to the PRODUCTION shop. That tooling
// bypassed this repo's client entirely, so no in-repo guard could have caught
// it — but the same review also had to establish that no *application* code
// path could do the same thing. Doing that by hand is a one-off; doing it as a
// test means the next mutation added to this repo cannot quietly skip the
// guard.
//
// Deliberately a source-text scan rather than a runtime check: the guarantee
// being asserted is "every file that can mutate calls the guard", which is a
// property of the code, not of any single execution.

const shopifyDir = fileURLToPath(new URL("../src/integrations/shopify/", import.meta.url));

const shopifyFiles = readdirSync(shopifyDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ name: f, source: readFileSync(shopifyDir + f, "utf-8") }));

/** A real GraphQL mutation operation definition, not the word in prose.
 * Operations in this repo are written inside template literals, one per line,
 * as `mutation Name(...)  {`. */
const MUTATION_OPERATION = /^\s*mutation\s+[A-Za-z]/m;

const GUARD = "assertShopifyWriteAllowed";

describe("Shopify write boundary — every mutation is guarded", () => {
  it("finds the expected set of mutation-performing files (and nothing unexpected)", () => {
    const withMutations = shopifyFiles.filter((f) => MUTATION_OPERATION.test(f.source)).map((f) => f.name);
    // If this list changes, the change is deliberate and the new file must
    // also appear guarded in the test below.
    expect(withMutations.sort()).toEqual(
      [
        "draft-order-mirror.ts",
        "order-fulfillment-mode-mirror.ts",
        "order-logistics-metafields.ts",
        "order-mirror.ts",
      ].sort(),
    );
  });

  it("every file containing a mutation also calls the write guard", () => {
    for (const file of shopifyFiles) {
      if (!MUTATION_OPERATION.test(file.source)) continue;
      expect(file.source, `${file.name} performs a mutation without ${GUARD}`).toContain(GUARD);
    }
  });

  it("the guard runs before the first Shopify request in each mutating file", () => {
    for (const file of shopifyFiles) {
      if (!MUTATION_OPERATION.test(file.source)) continue;
      const guardAt = file.source.indexOf(`await ${GUARD}(`);
      const firstCallAt = file.source.indexOf("await shopifyGraphQL");
      expect(guardAt, `${file.name} never awaits ${GUARD}`).toBeGreaterThan(-1);
      expect(
        guardAt,
        `${file.name} calls Shopify before ${GUARD} — the guard must come first`,
      ).toBeLessThan(firstCallAt);
    }
  });

  it("the guard itself fails closed on an unset or empty allowlist", () => {
    const guardSource = readFileSync(shopifyDir + "write-safety-guard.ts", "utf-8");
    // No allowlist configured -> throw, never "allow everything".
    expect(guardSource).toMatch(/if \(approved\.length === 0\) \{\s*throw/);
    // Membership is exact-match on a normalized domain, never a substring test.
    expect(guardSource).toContain("approved.includes(actual)");
    expect(guardSource).not.toMatch(/\.includes\(.*\.startsWith|endsWith\(/);
  });

  it("no Shopify mutation lives outside src/integrations/shopify", () => {
    // modules/ and app/ must delegate; they may never hold a mutation of
    // their own, which would sit outside the guarded layer entirely.
    const roots = ["../src/modules/", "../src/app/", "../src/platform/"];
    for (const root of roots) {
      const dir = fileURLToPath(new URL(root, import.meta.url));
      for (const file of walk(dir)) {
        const source = readFileSync(file, "utf-8");
        expect(MUTATION_OPERATION.test(source), `${file} contains a GraphQL mutation`).toBe(false);
      }
    }
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = dir + entry.name;
    if (entry.isDirectory()) out.push(...walk(full + "/"));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}
