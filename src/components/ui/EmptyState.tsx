import type { ReactNode } from "react";
import { Inbox, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";

type EmptyStateTone = "default" | "error";

export function EmptyState({
  title,
  description,
  action,
  icon,
  tone = "default",
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  tone?: EmptyStateTone;
}) {
  const resolvedIcon = icon ?? (tone === "error" ? <TriangleAlert className="h-5 w-5" /> : <Inbox className="h-5 w-5" />);

  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <div
        className={cn(
          "mb-1 flex h-9 w-9 items-center justify-center rounded-full",
          tone === "error" ? "bg-danger-50 text-danger-500" : "bg-canvas text-ink-tertiary",
        )}
        aria-hidden
      >
        {resolvedIcon}
      </div>
      <p className="text-sm font-medium text-ink-primary">{title}</p>
      {description && <p className="max-w-sm text-sm text-ink-tertiary">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
