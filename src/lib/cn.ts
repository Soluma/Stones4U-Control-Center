/** Minimal className joiner — filters falsy values, no dependency needed for
 * the conditional-class patterns actually used in this codebase. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
