import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/platform/auth/guards";
import { searchCustomers } from "@/modules/crm/customer-profile.service";
import { searchTasks } from "@/modules/tasks/task.service";
import { searchShopifyOrders } from "@/integrations/shopify/order-search";
import { isShopifyConfigured } from "@/integrations/shopify/client";
import { toErrorResponse } from "@/lib/api-error";

// Global command-palette search (Ctrl/Cmd+K). Phase 2 scope was customers +
// tasks; Phase 3a adds Shopify orders/draft orders
// (docs/platform-discovery/29-PHASE-3-BUILD-SPEC.md §4) — navigation is a
// static, client-side-only group (src/components/layout/CommandPalette.tsx),
// not part of this response. Structured as typed result groups so later
// phases (telephone numbers, quote IDs — Phase 3b) can add more groups
// without a breaking response-shape change. Email content is deliberately
// never indexed here (docs/architecture/ADR-008 / build spec §5).
export async function GET(request: NextRequest) {
  try {
    const actor = await requireUser();
    const term = request.nextUrl.searchParams.get("q")?.trim() ?? "";

    if (term.length < 2) {
      return NextResponse.json({ groups: [] });
    }

    const groups = [];

    if (isShopifyConfigured()) {
      const customers = await searchCustomers(term);
      groups.push({
        key: "customers",
        label: "Klanten",
        items: customers.map((c) => ({
          id: c.customerProfileId ?? c.shopify.gid,
          kind: "customer" as const,
          title: c.shopify.displayName,
          subtitle: [c.shopify.company, c.shopify.email].filter(Boolean).join(" · "),
          shopifyGid: c.shopify.gid,
        })),
      });
    }

    const tasks = await searchTasks(actor, term, 10);
    if (tasks.length > 0) {
      groups.push({
        key: "tasks",
        label: "Taken",
        items: tasks.map((t) => ({
          id: t.id,
          kind: "task" as const,
          title: t.title,
          subtitle: t.customerProfile?.displayName ?? t.customerProfile?.companyName ?? t.assignedTo.name,
          href: `/tasks/${t.id}`,
        })),
      });
    }

    if (isShopifyConfigured()) {
      try {
        const orders = await searchShopifyOrders(term);
        if (orders.length > 0) {
          groups.push({
            key: "orders",
            label: "Orders",
            items: orders.map((o) => ({
              id: o.gid,
              kind: "order" as const,
              title: o.name,
              subtitle: `${o.kind === "draft_order" ? "Concept · " : ""}${o.customerName}`,
              shopifyGid: o.customerGid,
            })),
          });
        }
      } catch (error) {
        // A Shopify order-search hiccup must not take down customer/task
        // results — same fail-isolation principle as every other Shopify
        // read path in this app.
        console.error("order_search_failed", error);
      }
    }

    return NextResponse.json({ groups });
  } catch (error) {
    return toErrorResponse(error);
  }
}
