import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
};

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "cc-btn-primary",
  secondary: "cc-btn-secondary",
  ghost: "cc-btn-ghost",
  danger: "cc-btn-danger",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "!px-2.5 !py-1.5 text-xs",
  md: "",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  disabled,
  children,
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(VARIANT_CLASS[variant], SIZE_CLASS[size], className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}
