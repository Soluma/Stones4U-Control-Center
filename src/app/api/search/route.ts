import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/platform/auth/guards";
import { searchCustomers } from "@/modules/crm/customer-profile.service";
import { searchTasks } from "@/modules/tasks/task.service";
import { isShopifyConfigured } from "@/integrations/shopify/client";
import { toErrorResponse } from "@/lib/api-error";

// Global command-palette search (Ctrl/Cmd+K). Phase 2 scope: customers +
// tasks (see docs/platform-discovery/26 §11) — navigation is a static,
// client-side-only group (src/components/layout/CommandPalette.tsx), not
// part of this response. Structured as typed result groups so later phases
// can add more groups without a breaking response-shape change.
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

    return NextResponse.json({ groups });
  } catch (error) {
    return toErrorResponse(error);
  }
}
