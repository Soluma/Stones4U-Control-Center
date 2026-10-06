import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf-8").replace(/\r\n/g, "\n");
}

describe("Dialog — focus is set once per opening, not on every render", () => {
  const dialog = source("src/components/ui/Dialog.tsx");

  it("runs the focus/keyboard lifecycle only per opening, never because onClose changed", () => {
    expect(dialog).toMatch(/\}, \[open, returnFocusTo\]\);/);
    expect(dialog).not.toMatch(/\[open, onClose\]/);
  });

  it("always calls the current onClose through a ref (Escape, backdrop, close button)", () => {
    expect(dialog).toContain("const onCloseRef = useRef(onClose);");
    expect(dialog).toMatch(/onCloseRef\.current = onClose;[\s\S]*\}, \[onClose\]\);/);
    expect(dialog).toMatch(/event\.key === "Escape"[\s\S]{0,120}onCloseRef\.current\(\)/);
    expect(dialog).not.toMatch(/onClick=\{onClose\}/);
  });

  it("keeps the Tab trap and restores focus on close", () => {
    expect(dialog).toContain('event.key !== "Tab"');
    expect(dialog).toContain("event.shiftKey && document.activeElement === first");
    expect(dialog).toContain("if (returnFocusTo?.isConnected) returnFocusTo.focus();");
  });

  it("captures the element to return focus to before autoFocus fields take focus", () => {
    // Captured while rendering the switch to open (before the commit in which
    // React applies autoFocus), not in the effect.
    expect(dialog).toMatch(/if \(open !== wasOpen\) \{[\s\S]{0,200}setReturnFocusTo\(document\.activeElement/);
    expect(dialog).not.toMatch(/useEffect\(\(\) => \{\s*if \(!open\) return;\s*\S*\s*=\s*document\.activeElement/);
  });

  it("puts initial focus on the autofocus field, else the first form field — not the close button", () => {
    expect(dialog).toContain("export function findInitialFocus");
    const fn = dialog.slice(dialog.indexOf("export function findInitialFocus"));
    const autofocus = fn.indexOf("[data-autofocus]");
    const field = fn.indexOf("FIELD_SELECTOR");
    const anyFocusable = fn.indexOf("FOCUSABLE_SELECTOR");
    expect(autofocus).toBeGreaterThan(-1);
    expect(field).toBeGreaterThan(autofocus);
    expect(anyFocusable).toBeGreaterThan(field);
  });
});

describe("Admin → Gebruikers form", () => {
  const users = source("src/app/(app)/admin/users/UsersAdmin.tsx");

  it("still has its four fields in the shared Dialog, name field first", () => {
    expect(users).toContain('from "@/components/ui/Dialog"');
    const order = ["Naam", "E-mailadres", "Tijdelijk wachtwoord", "Rol"].map((label) => users.indexOf(`label="${label}"`));
    order.forEach((index) => expect(index).toBeGreaterThan(-1));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("Dashboard", () => {
  const page = source("src/app/(app)/page.tsx");

  it("no longer shows or loads Recente CRM-activiteit", () => {
    expect(page).not.toContain("Recente CRM-activiteit");
    expect(page).not.toContain("getRecentActivity");
  });

  it("keeps Mijn Werk first, then the totals and appointments, then sales", () => {
    const myWork = page.indexOf('data-testid="dashboard-my-work"');
    const overview = page.indexOf('data-testid="dashboard-overview"');
    const sales = page.indexOf('data-testid="dashboard-sales"');
    expect(myWork).toBeGreaterThan(-1);
    expect(overview).toBeGreaterThan(myWork);
    expect(sales).toBeGreaterThan(overview);
    for (const block of ["MyWorkTasksList", "MyWorkAppointmentsList", "MyWorkOpportunitiesList", "TaskSummaryWidget", "Komende afspraken"]) {
      expect(page).toContain(block);
    }
  });
});

describe("Customer 360 overview — collapsible recent sections", () => {
  const section = source("src/components/ui/CollapsibleSection.tsx");
  const page = source("src/app/(app)/customers/[id]/page.tsx");

  it("CollapsibleSection is closed by default, a real button with aria-expanded/aria-controls", () => {
    expect(section).toContain("defaultOpen = false");
    expect(section).toContain("aria-expanded={open}");
    expect(section).toContain("aria-controls={contentId}");
    expect(section).toMatch(/<button\s+type="button"/);
    expect(section).toContain("setOpen((value) => !value)");
  });

  it("shows the count only when above 0 and renders an empty section as one compact row", () => {
    expect(section).toContain('typeof count === "number" && count > 0');
    expect(section).toContain('data-state="empty"');
  });

  it("wraps recent activity, calls and e-mails, with counts capped at what is shown", () => {
    expect(page).toContain('title="Recente activiteit" count={Math.min(timeline.length, RECENT_ACTIVITY_LIMIT)}');
    expect(page).toContain('title="Recente gesprekken" count={Math.min(recentCalls.length, RECENT_CALLS_LIMIT)}');
    expect(page).toContain('title="Recente e-mails" count={Math.min(emailMessages.length, RECENT_EMAILS_LIMIT)}');
    expect(page).toContain("<ActivityTimelineView items={timeline.slice(0, RECENT_ACTIVITY_LIMIT)} customerId={id} canEdit={canEdit} />");
  });
});

describe("Taken badge in the sidebar", () => {
  const sidebar = source("src/components/layout/Sidebar.tsx");
  const layout = source("src/app/(app)/layout.tsx");
  const route = source("src/app/api/tasks/open-count/route.ts");

  it("is computed server-side for the signed-in user and refreshed by event, without polling", () => {
    expect(layout).toContain("countOpenTasksAssignedTo(user.id)");
    expect(layout).toContain("<Sidebar openTaskCount={openTaskCount} />");
    expect(sidebar).toContain("TASKS_CHANGED_EVENT");
    expect(sidebar).toContain('"/api/tasks/open-count"');
    expect(sidebar).not.toMatch(/setInterval|setTimeout/);
    expect(sidebar).toContain("taskBadgeLabel");
    expect(route).toContain("requireUser");
    expect(route).toContain("countOpenTasksAssignedTo(actor.id)");
  });

  it("every task mutation in the UI announces the change", () => {
    for (const file of [
      "src/app/(app)/customers/[id]/CreateTaskDialog.tsx",
      "src/app/(app)/customers/[id]/TasksPanel.tsx",
      "src/app/(app)/tasks/TasksList.tsx",
      "src/app/(app)/tasks/[id]/TaskDetailView.tsx",
    ]) {
      expect(source(file), file).toContain("notifyTasksChanged()");
    }
  });

  it("uses one definition of open statuses everywhere", () => {
    for (const file of ["src/modules/tasks/task.service.ts", "src/modules/dashboard/my-work.ts", "src/modules/opportunities/opportunity.service.ts", "src/app/(app)/customers/[id]/page.tsx"]) {
      const text = source(file);
      expect(text, file).toContain("OPEN_TASK_STATUSES");
      expect(text, file).not.toMatch(/\["OPEN", "IN_PROGRESS", "WAITING"\]/);
    }
  });
});

describe("Task description on every create flow", () => {
  const dialog = source("src/app/(app)/customers/[id]/CreateTaskDialog.tsx");
  const list = source("src/app/(app)/tasks/TasksList.tsx");
  const detail = source("src/app/(app)/tasks/[id]/TaskDetailView.tsx");

  it("the shared create dialog has a multi-line, optional description up to 5000 characters and posts it", () => {
    expect(dialog).toContain('import { TASK_DESCRIPTION_MAX } from "@/modules/tasks/task-input";');
    expect(dialog).toContain('label="Omschrijving (optioneel)"');
    expect(dialog).toContain("rows={7}");
    expect(dialog).toContain("maxLength={TASK_DESCRIPTION_MAX}");
    expect(dialog).toContain("description: description.trim().length > 0 ? description : undefined");
    expect(dialog).toContain("if (!response.ok)");
  });

  it("the central /tasks uses the same dialog instead of its own form", () => {
    expect(list).toContain('<CreateTaskDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onCreated={refresh} basePath="/api" />');
    expect(list).not.toContain('from "@/components/ui/Dialog"');
  });

  it("customer and opportunity pages use the shared task panel with that dialog", () => {
    expect(source("src/app/(app)/customers/[id]/TasksPanel.tsx")).toContain("<CreateTaskDialog");
    expect(source("src/app/(app)/opportunities/[id]/page.tsx")).toContain("<TasksPanel opportunityId={id}");
  });

  it("all create APIs and the edit API validate the description with the one shared schema", () => {
    for (const file of ["src/app/api/tasks/route.ts", "src/app/api/customers/[id]/tasks/route.ts", "src/app/api/opportunities/[id]/tasks/route.ts"]) {
      expect(source(file), file).toContain("description: taskDescriptionSchema.optional()");
    }
    expect(source("src/app/api/tasks/[id]/route.ts")).toContain("description: taskDescriptionSchema.nullable().optional()");
  });

  it("the detail view shows the description as plain text with line breaks and wrapping", () => {
    expect(detail).toContain('data-testid="task-description"');
    expect(detail).toContain("whitespace-pre-wrap");
    expect(detail).toContain("break-words");
    expect(detail).not.toContain("dangerouslySetInnerHTML");
    expect(detail).toContain("maxLength={TASK_DESCRIPTION_MAX}");
  });
});
