import { ChangePasswordForm } from "./ChangePasswordForm";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-primary">Instellingen</h1>
        <p className="mt-1 text-sm text-ink-tertiary">Persoonlijke accountinstellingen.</p>
      </div>
      <ChangePasswordForm />
    </div>
  );
}
