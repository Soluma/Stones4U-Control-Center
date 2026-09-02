"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";

export function LogoutButton() {
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return <IconButton icon={<LogOut className="h-4 w-4" />} label="Uitloggen" onClick={handleLogout} />;
}
