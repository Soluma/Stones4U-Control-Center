"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Users, Mail, Phone, Pencil, Archive, RotateCcw, Star, ShieldCheck, Receipt } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { CopyButton } from "@/components/ui/CopyButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonList } from "@/components/ui/Skeleton";
import { ContactDialog, type ContactFormValues } from "./ContactDialog";

type ContactRow = {
  id: string;
  displayName: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  isDecisionMaker: boolean;
  isBillingContact: boolean;
  archivedAt: string | null;
};

// Customer 360 Overzicht-tab section — no new top-level tab (architecture
// doc §6/build spec §15). Self-fetching client component, same pattern as
// OpportunitiesSection.tsx.
export function ContactsSection({ customerId, canEdit }: { customerId: string; canEdit: boolean }) {
  const [contacts, setContacts] = useState<ContactRow[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<ContactRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/customers/${customerId}/contacts${showArchived ? "?archived=include" : ""}`);
    const data = await response.json();
    setContacts(data.contacts ?? []);
  }, [customerId, showArchived]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function openCreate() {
    setEditingContact(null);
    setDialogOpen(true);
  }

  function openEdit(contact: ContactRow) {
    setEditingContact(contact);
    setDialogOpen(true);
  }

  async function handleArchive(contactId: string) {
    setBusyId(contactId);
    await fetch(`/api/customers/${customerId}/contacts/${contactId}/archive`, { method: "POST" });
    setBusyId(null);
    void refresh();
  }

  async function handleRestore(contactId: string) {
    setBusyId(contactId);
    await fetch(`/api/customers/${customerId}/contacts/${contactId}/restore`, { method: "POST" });
    setBusyId(null);
    void refresh();
  }

  const editingValues: ContactFormValues | undefined = editingContact
    ? {
        displayName: editingContact.displayName,
        jobTitle: editingContact.jobTitle ?? "",
        email: editingContact.email ?? "",
        phone: editingContact.phone ?? "",
        isPrimary: editingContact.isPrimary,
        isDecisionMaker: editingContact.isDecisionMaker,
        isBillingContact: editingContact.isBillingContact,
      }
    : undefined;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-ink-secondary">Contactpersonen</h2>
        {canEdit && (
          <Button variant="secondary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={openCreate}>
            Contactpersoon
          </Button>
        )}
      </div>

      {contacts === null && <SkeletonList rows={2} />}
      {contacts !== null && contacts.length === 0 && (
        <EmptyState icon={<Users className="h-5 w-5" />} title="Geen contactpersonen" description="Er zijn nog geen contactpersonen bij deze klant vastgelegd." />
      )}

      {contacts !== null && contacts.length > 0 && (
        <div className="cc-card divide-y divide-border-subtle">
          {contacts.map((contact) => (
            <div key={contact.id} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className={`truncate font-medium ${contact.archivedAt ? "text-ink-tertiary line-through" : "text-ink-primary"}`}>
                    {contact.displayName}
                  </p>
                  {contact.jobTitle && <span className="truncate text-xs text-ink-tertiary">{contact.jobTitle}</span>}
                  {contact.isPrimary && (
                    <Badge tone="accent">
                      <Star className="h-3 w-3" aria-hidden /> Primair
                    </Badge>
                  )}
                  {contact.isDecisionMaker && (
                    <Badge tone="neutral">
                      <ShieldCheck className="h-3 w-3" aria-hidden /> Beslisser
                    </Badge>
                  )}
                  {contact.isBillingContact && (
                    <Badge tone="neutral">
                      <Receipt className="h-3 w-3" aria-hidden /> Facturatie
                    </Badge>
                  )}
                  {contact.archivedAt && <Badge tone="neutral">Gearchiveerd</Badge>}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-tertiary">
                  {contact.email && (
                    <span className="flex items-center gap-1">
                      <Mail className="h-3 w-3" aria-hidden />
                      <a href={`mailto:${contact.email}`} className="hover:underline">
                        {contact.email}
                      </a>
                      <CopyButton value={contact.email} label="E-mailadres kopiëren" />
                    </span>
                  )}
                  {contact.phone && (
                    <span className="flex items-center gap-1">
                      <Phone className="h-3 w-3" aria-hidden />
                      <a href={`tel:${contact.phone}`} className="hover:underline">
                        {contact.phone}
                      </a>
                      <CopyButton value={contact.phone} label="Telefoonnummer kopiëren" />
                    </span>
                  )}
                </div>
              </div>

              {canEdit && (
                <div className="flex shrink-0 items-center gap-1">
                  {!contact.archivedAt && (
                    <>
                      <IconButton icon={<Pencil className="h-3.5 w-3.5" aria-hidden />} label="Bewerken" onClick={() => openEdit(contact)} />
                      <IconButton
                        icon={<Archive className="h-3.5 w-3.5" aria-hidden />}
                        label="Archiveren"
                        disabled={busyId === contact.id}
                        onClick={() => handleArchive(contact.id)}
                      />
                    </>
                  )}
                  {contact.archivedAt && (
                    <IconButton
                      icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden />}
                      label="Herstellen"
                      disabled={busyId === contact.id}
                      onClick={() => handleRestore(contact.id)}
                    />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {contacts !== null && (
        <button type="button" onClick={() => setShowArchived((v) => !v)} className="text-xs text-accent-600 hover:underline">
          {showArchived ? "Verberg gearchiveerde contactpersonen" : "Toon gearchiveerde contactpersonen"}
        </button>
      )}

      <ContactDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={refresh}
        customerId={customerId}
        contactId={editingContact?.id}
        initial={editingValues}
      />
    </div>
  );
}
