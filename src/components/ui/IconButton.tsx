import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ReactNode;
  label: string;
  tone?: "default" | "danger";
};

/** Icon-only button — always requires a `label` used as both the
 * accessible name (aria-label) and the native tooltip (title), since there
 * is no separate Tooltip component in this library (deliberately — see
 * docs/build/PHASE-1-UI-UX-PASS.md "component library"). */
export function IconButton({ icon, label, tone = "default", className, ...props }: IconButtonProps) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn("cc-icon-btn", tone === "danger" && "hover:!bg-danger-50 hover:!text-danger-700", className)}
      {...props}
    >
      {icon}
    </button>
  );
}
