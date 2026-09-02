import { CommandPalette } from "./CommandPalette";
import { LogoutButton } from "./LogoutButton";
import type { SessionUser } from "@/platform/auth/session";

const ROLE_LABEL: Record<SessionUser["role"], string> = {
  ADMIN: "Beheerder",
  AGENT: "Medewerker",
  VIEWER: "Alleen-lezen",
};

export function Topbar({ user }: { user: SessionUser }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border-subtle bg-surface px-5">
      <CommandPalette />
      <div className="flex items-center gap-3">
        <div className="text-right">
          <p className="text-sm font-medium leading-tight text-ink-primary">{user.name}</p>
          <p className="text-xs leading-tight text-ink-tertiary">{ROLE_LABEL[user.role]}</p>
        </div>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-100 text-xs font-semibold text-accent-700">
          {user.name.slice(0, 2).toUpperCase()}
        </div>
        <LogoutButton />
      </div>
    </header>
  );
}
