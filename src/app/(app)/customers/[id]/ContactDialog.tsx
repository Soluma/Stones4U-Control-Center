"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";

export type ContactFormValues = {
  displayName: string;
  jobTitle: string;
  email: string;
  phone: string;
  isPrimary: boolean;
  isDecisionMaker: boolean;
  isBillingContact: boolean;
};

const EMPTY_FORM: ContactFormValues = {
  displayName: "",
  jobTitle: "",
  email: "",
  phone: "",
  isPrimary: false,
  isDecisionMaker: false,
  isBillingContact: false,
};

// Small, deliberately minimal form (build spec §16 — "geen enorme modal").
// Used for both create and edit: pass `initial` for edit mode.
export function ContactDialog({
  open,
  onClose,
  onSaved,
  customerId,
  contactId,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  customerId: string;
  contactId?: string;
  initial?: ContactFormValues;
}) {
  const [values, setValues] = useState<ContactFormValues>(initial ?? EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setValues(initial ?? EMPTY_FORM);
    setError(null);
    setDuplicateWarning(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handleSave() {
    if (values.displayName.trim().length === 0) return;
    setSubmitting(true);
    setError(null);
    setDuplicateWarning(null);

    const body = {
      displayName: values.displayName,
      jobTitle: values.jobTitle || null,
      email: values.email || null,
      phone: values.phone || null,
      isPrimary: values.isPrimary,
      isDecisionMaker: values.isDecisionMaker,
      isBillingContact: values.isBillingContact,
    };
    const url = contactId ? `/api/customers/${customerId}/contacts/${contactId}` : `/api/customers/${customerId}/contacts`;
    const response = await fetch(url, {
      method: contactId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSubmitting(false);

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      setError(errorBody?.error ?? "Opslaan mislukt.");
      return;
    }

    const data = await response.json();
    if (data.duplicateWarning) {
      const fieldLabel = data.duplicateWarning.field === "email" ? "e-mailadres" : "telefoonnummer";
      setDuplicateWarning(`Dit ${fieldLabel} wordt al gebruikt door een andere contactpersoon bij deze klant.`);
    }

    onSaved();
    onClose();
  }

  const canSubmit = values.displayName.trim().length > 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={contactId ? "Contactpersoon bewerken" : "Nieuwe contactpersoon"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant="primary" loading={submitting} disabled={!canSubmit} onClick={handleSave}>
            Opslaan
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <p className="text-xs text-danger-500">{error}</p>}
        {duplicateWarning && <p className="text-xs text-warning-700">{duplicateWarning}</p>}

        <Input
          label="Naam"
          value={values.displayName}
          onChange={(e) => setValues((v) => ({ ...v, displayName: e.target.value }))}
          placeholder="Bijv. Jan Jansen"
          autoFocus
        />
        <Input
          label="Functie (optioneel)"
          value={values.jobTitle}
          onChange={(e) => setValues((v) => ({ ...v, jobTitle: e.target.value }))}
          placeholder="Bijv. Eigenaar"
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="E-mail (optioneel)"
            type="email"
            value={values.email}
            onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))}
          />
          <Input
            label="Telefoon (optioneel)"
            type="tel"
            value={values.phone}
            onChange={(e) => setValues((v) => ({ ...v, phone: e.target.value }))}
          />
        </div>

        <div className="flex flex-wrap gap-4 pt-1">
          <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
            <input
              type="checkbox"
              checked={values.isPrimary}
              onChange={(e) => setValues((v) => ({ ...v, isPrimary: e.target.checked }))}
              className="h-3.5 w-3.5 rounded border-border text-accent-600 focus:ring-accent-500"
            />
            Primair contact
          </label>
          <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
            <input
              type="checkbox"
              checked={values.isDecisionMaker}
              onChange={(e) => setValues((v) => ({ ...v, isDecisionMaker: e.target.checked }))}
              className="h-3.5 w-3.5 rounded border-border text-accent-600 focus:ring-accent-500"
            />
            Beslisser
          </label>
          <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
            <input
              type="checkbox"
              checked={values.isBillingContact}
              onChange={(e) => setValues((v) => ({ ...v, isBillingContact: e.target.checked }))}
              className="h-3.5 w-3.5 rounded border-border text-accent-600 focus:ring-accent-500"
            />
            Facturatiecontact
          </label>
        </div>
      </div>
    </Dialog>
  );
}
