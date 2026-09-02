import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Thin, consistent styling wrapper around a native <table> — deliberately
 * not a generic column/row-config abstraction (OrdersTable, UsersAdmin, and
 * TasksList each have different enough column shapes that a fully generic
 * Table would be more ceremony than the three call sites it would serve;
 * see docs/build/PHASE-1-UI-UX-PASS.md "component library"). Always wrapped
 * in a horizontal-scroll container so a table never breaks desktop layout
 * at 1366px. */
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="cc-card overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">{children}</table>
    </div>
  );
}

export function TableHead({ children }: { children: ReactNode }) {
  return (
    <thead>
      <tr className="border-b border-border-subtle text-left text-xs text-ink-tertiary">{children}</tr>
    </thead>
  );
}

export function TableHeaderCell({ children, className }: { children: ReactNode; className?: string }) {
  return <th className={cn("px-4 py-2.5 font-medium", className)}>{children}</th>;
}

export function TableBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-border-subtle">{children}</tbody>;
}

export function TableRow({ children, className }: { children: ReactNode; className?: string }) {
  return <tr className={cn("cc-table-row", className)}>{children}</tr>;
}

export function TableCell({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn("px-4 py-2.5 align-middle", className)}>{children}</td>;
}
