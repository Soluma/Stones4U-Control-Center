import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type FieldWrapperProps = {
  htmlFor?: string;
  label?: string;
  hint?: string;
  hintId?: string;
  error?: string;
  errorId?: string;
  children: ReactNode;
};

function FieldWrapper({ htmlFor, label, hint, hintId, error, errorId, children }: FieldWrapperProps) {
  return (
    <div>
      {label && (
        <label htmlFor={htmlFor} className="cc-label">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-danger-500">
          {error}
        </p>
      ) : (
        hint && (
          <p id={hintId} className="mt-1 text-xs text-ink-tertiary">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

export function Input({
  label,
  hint,
  error,
  className,
  id,
  "aria-describedby": ariaDescribedBy,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label?: string; hint?: string; error?: string }) {
  const hintId = hint && id ? `${id}-hint` : undefined;
  const errorId = error && id ? `${id}-error` : undefined;
  // Combine rather than clobber — a caller-supplied aria-describedby (none
  // does today) stays alongside the hint/error id instead of being
  // silently discarded by the later {...props} spread.
  const describedBy = [ariaDescribedBy, errorId ?? hintId].filter(Boolean).join(" ") || undefined;
  return (
    <FieldWrapper htmlFor={id} label={label} hint={hint} hintId={hintId} error={error} errorId={errorId}>
      <input
        id={id}
        className={cn("cc-input", error && "border-danger-500 focus:ring-danger-500", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...props}
      />
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
