import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/platform/auth/guards";
import { searchCustomers } from "@/modules/crm/customer-profile.service";
import { searchTasks } from "@/modules/tasks/task.service";
import { searchShopifyOrders } from "@/integrations/shopify/order-search";
import { isShopifyConfigured } from "@/integrations/shopify/client";
import { searchQuotesByNumber } from "@/integrations/quotes/adapter";
import { searchOpportunities } from "@/modules/opportunities/opportunity.service";
import { searchCustomerContacts } from "@/modules/crm/customer-contact.service";
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

    try {
      const quotes = await searchQuotesByNumber(term);
      if (quotes.length > 0) {
        groups.push({
          key: "quotes",
          label: "Offertes",
          items: quotes.map((q) => ({
            id: `${q.sourceSystem}-${q.externalId}`,
            kind: "quote" as const,
            title: q.displayNumber,
            subtitle: q.customerName,
            customerProfileId: q.customerProfileId,
          })),
        });
      }
    } catch (error) {
      // Same fail-isolation principle as the Shopify order search above —
      // a quote-search hiccup must not take down the rest of the palette.
      console.error("quote_search_failed", error);
    }

    // Phase 4a — docs/platform-discovery/33-PHASE-4A-BUILD-SPEC.md §4. Own
    // try/catch, same fail-isolation as orders/quotes above.
    try {
      const opportunities = await searchOpportunities(term);
      if (opportunities.length > 0) {
        groups.push({
          key: "opportunities",
          label: "Verkoopkansen",
          items: opportunities.map((o) => ({
            id: o.id,
            kind: "opportunity" as const,
            title: o.title,
            subtitle: o.customerProfile.displayName ?? o.customerProfile.companyName ?? "Klant",
            href: `/opportunities/${o.id}`,
          })),
        });
      }
    } catch (error) {
      console.error("opportunity_search_failed", error);
    }

    // Phase 4c — docs/platform-discovery/38-PHASE-4C-CONTACTS-ARCHITECTURE.md
    // §13. Own try/catch, same fail-isolation as orders/quotes/opportunities
    // above. Searches only CustomerContact's own fields — never the
    // customer's own name (that's the existing `customers` group above).
    try {
      const contacts = await searchCustomerContacts(term);
      if (contacts.length > 0) {
        groups.push({
          key: "contacts",
          label: "Contactpersonen",
          items: contacts.map((c) => ({
            id: c.id,
            kind: "contact" as const,
            title: c.displayName,
            subtitle: [c.customerProfile.displayName ?? c.customerProfile.companyName, c.email].filter(Boolean).join(" · "),
            href: `/customers/${c.customerProfileId}`,
          })),
        });
      }
    } catch (error) {
      console.error("contact_search_failed", error);
    }

    return NextResponse.json({ groups });
  } catch (error) {
    return toErrorResponse(error);
  }
}
