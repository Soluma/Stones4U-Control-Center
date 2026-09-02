import { redirect } from "next/navigation";
import { Gem } from "lucide-react";
import { getSessionUser } from "@/platform/auth/session";
import { LoginForm } from "./LoginForm";

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/");

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-accent-500 text-white">
            <Gem className="h-5 w-5" aria-hidden />
          </div>
          <p className="text-lg font-semibold tracking-tight text-ink-primary">Stones4U Control Center</p>
          <p className="mt-1 text-sm text-ink-tertiary">Log in met je Control Center-account</p>
        </div>
        <div className="cc-card p-6">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
