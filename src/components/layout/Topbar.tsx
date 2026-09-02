import { CommandPalette } from "./CommandPalette";
import { LogoutButton } from "./LogoutButton";
import { PageContext } from "./PageContext";
import { Avatar } from "@/components/ui/Avatar";
import type { SessionUser } from "@/platform/auth/session";

const ROLE_LABEL: Record<SessionUser["role"], string> = {
  ADMIN: "Beheerder",
  AGENT: "Medewerker",
  VIEWER: "Alleen-lezen",
};

export function Topbar({ user }: { user: SessionUser }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border-subtle bg-surface px-5">
      <PageContext />
      <div className="flex flex-1 items-center justify-end gap-3">
        <CommandPalette />
        <div className="flex items-center gap-2.5 border-l border-border-subtle pl-3">
          <Avatar name={user.name} size="sm" />
          <div className="hidden text-right leading-tight sm:block">
            <p className="text-sm font-medium text-ink-primary">{user.name}</p>
            <p className="text-xs text-ink-tertiary">{ROLE_LABEL[user.role]}</p>
          </div>
          <LogoutButton />
        </div>
      </div>
    </header>
  );
}
