import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Same source-text technique as tests/staff-order-handoff-ui-copy.test.ts
// (this repo has no React-component-render pipeline). What is pinned here
// is not styling but the promises the logistics feature makes: it shows
// OfferteApp's canonical values rather than re-deriving them, it never
// dresses an outage up as an empty warehouse, and looking at an order
// changes nothing anywhere.

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf-8");
}

function flatten(source: string): string {
  return source.replace(/\s+/g, " ");
}

const ORDERS_TABLE = "src/app/(app)/customers/[id]/OrdersTable.tsx";
const LOGISTICS_BLOCK = "src/app/(app)/customers/[id]/LogisticsBlock.tsx";
const ORDER_PAGE = "src/app/(app)/customers/[id]/orders/[orderId]/page.tsx";
const WAREHOUSE_SECTION = "src/app/(app)/customers/[id]/orders/[orderId]/WarehouseLogisticsSection.tsx";
const CUSTOMER_PAGE = "src/app/(app)/customers/[id]/page.tsx";

const ALL_LOGISTICS_SOURCES = [
  ORDERS_TABLE,
  LOGISTICS_BLOCK,
  ORDER_PAGE,
  WAREHOUSE_SECTION,
  "src/modules/logistics/presentation.ts",
  "src/modules/logistics/line-join.ts",
  "src/modules/logistics/timeline.ts",
  "src/integrations/logistics/adapter.ts",
  "src/integrations/logistics/types.ts",
];

describe("the CRM consumes canonical values and derives none of them", () => {
  it("never matches on a Dutch operational status string anywhere in the logistics code", () => {
    // These are OfferteApp's stored status values. The CRM may display one
    // (it arrives as a label), but must never branch on it — that is what
    // handoffType and scheduleState exist for.
    const storedStatuses = [
      "Wacht op klant",
      "Picken landelijk",
      "Picken regio",
      "Picken voor afhalen",
      "Klaar voor ophalen transporteur",
      "Klaar voor ophalen Hoefnagels",
      "Klaar voor afhalen klant",
      "Gepland met Hoefnagels",
      "Afgeleverd / Opgehaald",
    ];
    for (const path of ALL_LOGISTICS_SOURCES) {
      const source = read(path);
      for (const status of storedStatuses) {
        expect(source, `${path} must not branch on "${status}"`).not.toContain(`"${status}"`);
      }
    }
  });

  it("never computes a Van Eijk pickup day — OfferteApp already derived it", () => {
    for (const path of ALL_LOGISTICS_SOURCES) {
      const source = read(path);
      expect(source).not.toMatch(/getDay\(\)|addDays|werkdag|workingDay/i);
    }
  });

  it("takes every label from the shared presentation module instead of inlining its own", () => {
    for (const path of [ORDERS_TABLE, LOGISTICS_BLOCK, WAREHOUSE_SECTION]) {
      expect(read(path)).toContain('from "@/modules/logistics/presentation"');
    }
    const labels = read("src/modules/logistics/presentation.ts");
    expect(labels).toContain('VAN_EIJK: "Van Eijk"');
    expect(labels).toContain('HOEFNAGELS: "Hoefnagels"');
    expect(labels).toContain('CUSTOMER_PICKUP: "Afhalen klant"');
    expect(labels).toContain('UNKNOWN: "Afhandeling onbekend"');
  });
});

describe("customer card — Logistiek", () => {
  const source = read(LOGISTICS_BLOCK);
  const flat = flatten(source);

  it("leads with the orders that still need something", () => {
    expect(source).toContain("needsAttention");
    expect(flat).toContain("Logistiek");
  });

  it("shows per order the number, handoff, date, status, pick progress and pallets", () => {
    expect(source).toContain("order.orderName");
    expect(source).toContain("handoffLabel(order.handoffType)");
    expect(source).toContain("scheduleDisplay(order.scheduleState, order.requestedDate)");
    expect(source).toContain("statusLabel(order.operationalStatus)");
    expect(flat).toContain("regels gepickt");
    expect(flat).toContain("pallets gescand");
  });

  it("shows the lock only while it is active, as a person and not as a status", () => {
    expect(source).toContain("order.lock.active &&");
    expect(flat).toContain("Wordt nu gepickt door ${order.lock.claimedByName}");
  });

  it("uses the batch endpoint's lastEvent rather than a per-order detail call", () => {
    expect(source).toContain("order.lastEvent");
    expect(source).not.toContain("getForOrder(");
  });

  it("links each order to its CRM order page", () => {
    expect(source).toContain("href={`/customers/${customerId}/orders/${order.shopifyOrderId}`}");
  });

  it("says an outage is an outage, and an empty warehouse an empty warehouse", () => {
    expect(flat).toContain("Logistieke gegevens tijdelijk niet beschikbaar.");
    expect(flat).toContain("Geen orders in het magazijn.");
  });
});

describe("order history — the Commercieel table", () => {
  const source = read(ORDERS_TABLE);
  const flat = flatten(source);

  it("adds Afhandeling and Magazijn without dropping the commercial columns", () => {
    for (const column of ["Order", "Datum", "Betaalstatus", "Totaal", "Afhandeling", "Magazijn"]) {
      expect(flat, `column ${column}`).toMatch(new RegExp(`<TableHeaderCell[^>]*>${column}</TableHeaderCell>`));
    }
  });

  it("keeps a completed order short: a date, not a progress read-out", () => {
    expect(source).toContain("item.pick.completed ?");
    expect(flat).toContain("Gepickt ${formatDate(item.pick.completedAt)}");
  });

  it("distinguishes 'no data for this order' from 'OfferteApp did not answer'", () => {
    expect(source).toContain('unavailable ? "Niet beschikbaar" : "—"');
    expect(flat).toContain("Logistieke gegevens tijdelijk niet beschikbaar");
  });

  it("never renders a missing answer as zero pallets or as not picked", () => {
    expect(source).not.toMatch(/0 \/ 0 pallets/);
    expect(source).not.toContain("niet gepickt");
  });
});

describe("order detail — Magazijn & logistiek", () => {
  const source = read(WAREHOUSE_SECTION);
  const flat = flatten(source);

  it("carries the five blocks in the order staff read them", () => {
    expect(flat).toContain("Magazijn &amp; logistiek");
    for (const heading of ["Status", "Afhandeling", "Gewenste datum", "Picken", "Pickregels", "Pallets"]) {
      expect(flat).toContain(heading);
    }
    expect(flat).toContain("Foto&apos;s van deze order");
  });

  it("shows picking as progress and people, never as a status", () => {
    expect(source).toContain("order.pick.pickedLines");
    expect(source).toContain("order.pick.deviationCount > 0");
    expect(source).toContain("order.lock.active &&");
    expect(source).toContain("order.lock.claimedAt");
    expect(source).toContain("order.lock.lastActivityAt");
    expect(flat).toContain("Wordt nu gepickt door ${order.lock.claimedByName}");
  });

  it("joins pick lines on the line-item id and says so visibly when one cannot be matched", () => {
    expect(source).toContain("joinLogisticsLines(shopifyLines, order.lines)");
    expect(source).not.toMatch(/\.sku\s*===|title\s*===/);
    expect(source).toContain("join.unmatchedPickLines.length > 0");
    expect(flat).toContain("Geen pickgegevens");
  });

  it("shows pallets only when OfferteApp actually has pallet rows", () => {
    expect(source).toContain("order.palletDetails.length > 0 &&");
  });

  it("shows photos as belonging to the order, thumbnails from thumbUrl and the full image from url", () => {
    expect(flat).toContain("Foto&apos;s van deze order");
    expect(source).toContain("href={photo.url ?? photo.thumbUrl");
    expect(source).toContain("src={photo.thumbUrl ?? photo.url");
    expect(source).toContain("order.photos.pendingCount");
    expect(source).toContain("order.photos.failedCount");
  });

  it("states an integration problem as one, per reason, inside its own section", () => {
    expect(flat).toContain("Logistieke gegevens tijdelijk niet beschikbaar.");
    expect(flat).toContain("niet bekend in OfferteApp");
    expect(flat).toContain("OfferteApp is niet gekoppeld");
    expect(source).not.toContain("Op afroep");
  });
});

describe("looking at logistics never writes anything", () => {
  it("the logistics code and the order page touch no Prisma write and no audit call", () => {
    for (const path of [...ALL_LOGISTICS_SOURCES, LOGISTICS_BLOCK]) {
      const source = read(path);
      expect(source, `${path} must not write`).not.toMatch(
        /prisma\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/,
      );
      expect(source, `${path} must not audit`).not.toMatch(/recordAudit|writeAudit/);
    }
  });

  it("the order page reads Shopify and OfferteApp only, and never posts to either", () => {
    const source = read(ORDER_PAGE);
    expect(source).toContain("prisma.customerProfile.findUnique");
    expect(source).toContain("getShopifyOrderDetail");
    expect(source).toContain("getForOrder(orderId)");
    expect(source).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
    expect(source).not.toContain("shopifyGraphQL(");
  });

  it("only ever reads OfferteApp over GET", () => {
    const adapter = read("src/integrations/logistics/adapter.ts");
    expect(adapter).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
    expect(adapter).toContain('import "server-only"');
  });

  it("stores no logistics data: no Prisma model, no mirror table, no copied columns", () => {
    const schema = read("prisma/schema.prisma");
    for (const model of ["PickOrder", "Pallet", "PickLine", "LogisticsEvent", "OrderLogistics"]) {
      expect(schema).not.toContain(`model ${model} `);
    }
    expect(schema).not.toContain("handoffType");
    expect(schema).not.toContain("scheduleState");
  });
});

describe("the customer page asks once for every order", () => {
  const source = read(CUSTOMER_PAGE);

  it("uses the batch call, not one call per order", () => {
    expect(source).toContain("getForOrders(orderIds)");
    expect(source).not.toContain("getForOrder(");
    expect(source).not.toMatch(/orders\.map\([^)]*getForOrder/);
  });

  it("isolates a logistics failure from the rest of Customer 360", () => {
    expect(source).toContain("logistics_fetch_failed");
    expect(source).toContain('{ byOrderId: new Map(), unavailable: true }');
  });

  it("hides the logistics columns entirely when OfferteApp is not configured", () => {
    expect(source).toContain("logisticsAdapter.status().available");
  });
});
