// Phase 6c — shared copy-to-clipboard helper, extracted from
// ContactsSection.tsx's local copyToClipboard() so the new quick-action
// locations (header, Recent-blokken, tijdlijn) don't each reimplement it.
// Fire-and-forget, same as before — but now used from three more places
// (the header, in particular), so an unavailable/denied clipboard API
// (older browser, non-secure context, permission denial) must never throw
// into the click handler or leave an unhandled rejection; it should just
// silently no-op.
export function copyToClipboard(value: string): void {
  try {
    void navigator.clipboard?.writeText(value)?.catch(() => undefined);
  } catch {
    // no-op — copy is a convenience action, never allowed to break the page
  }
}
