import Link from "next/link";
import { NAV_SECTIONS } from "./nav-config";

export function Sidebar() {
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-border-subtle bg-surface md:flex">
      <div className="flex h-14 items-center gap-2 border-b border-border-subtle px-4">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-500 text-xs font-bold text-white">
          S4
        </div>
        <span className="text-sm font-semibold tracking-tight text-ink-primary">Control Center</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label ?? "root"}>
            {section.label && (
              <p className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-disabled">
                {section.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.label}>
                  {item.href ? (
                    <Link
                      href={item.href}
                      className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-ink-secondary hover:bg-canvas hover:text-ink-primary transition-colors"
                    >
                      {item.label}
                    </Link>
                  ) : (
                    <span className="flex cursor-default items-center justify-between rounded-md px-2 py-1.5 text-sm text-ink-disabled">
                      {item.label}
                      {item.comingSoon && (
                        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-tertiary">
                          Binnenkort
                        </span>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
