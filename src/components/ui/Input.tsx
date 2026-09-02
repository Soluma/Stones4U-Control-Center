import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type FieldWrapperProps = { label?: string; hint?: string; error?: string; children: ReactNode };

function FieldWrapper({ label, hint, error, children }: FieldWrapperProps) {
  return (
    <div>
      {label && <label className="cc-label">{label}</label>}
      {children}
      {error ? (
        <p className="mt-1 text-xs text-danger-500">{error}</p>
      ) : (
        hint && <p className="mt-1 text-xs text-ink-tertiary">{hint}</p>
      )}
    </div>
  );
}

export function Input({
  label,
  hint,
  error,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; error?: string }) {
  return (
    <FieldWrapper label={label} hint={hint} error={error}>
      <input className={cn("cc-input", error && "border-danger-500 focus:ring-danger-500", className)} {...props} />
    </FieldWrapper>
  );
}

export function Textarea({
  label,
  hint,
  error,
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; hint?: string; error?: string }) {
  return (
    <FieldWrapper label={label} hint={hint} error={error}>
      <textarea
        className={cn("cc-input resize-none leading-relaxed", error && "border-danger-500 focus:ring-danger-500", className)}
        {...props}
      />
    </FieldWrapper>
  );
}

export function Select({
  label,
  hint,
  error,
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label?: string; hint?: string; error?: string }) {
  return (
    <FieldWrapper label={label} hint={hint} error={error}>
      <select className={cn("cc-input pr-8", className)} {...props}>
        {children}
      </select>
    </FieldWrapper>
  );
}
