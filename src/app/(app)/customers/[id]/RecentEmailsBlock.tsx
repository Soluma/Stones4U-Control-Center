import { ArrowDownLeft, ArrowUpRight, ExternalLink } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import type { NormalizedEmailMessage } from "@/integrations/email/types";

// Overview-tab compact block (docs/platform-discovery/28-PHASE-3-ARCHITECTURE.md
// §4.1 / 30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md §9 — no new tab, a small
// block alongside "Recente gesprekken"). Never renders bodyPreview as HTML —
// it is always plain-text-interpolated React content, never
// dangerouslySetInnerHTML, so a message body can never inject markup.
export function RecentEmailsBlock({ messages }: { messages: NormalizedEmailMessage[] }) {
  const recent = messages.slice(0, 5);

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-ink-secondary">Recente e-mails</h2>
      {recent.length === 0 ? (
        <p className="cc-card p-4 text-sm text-ink-tertiary">Geen recente e-mails.</p>
      ) : (
        <div className="cc-card divide-y divide-border-subtle">
          {recent.map((message) => {
            const inbound = message.direction === "INBOUND";
            const counterpart = inbound
              ? message.from.name ?? message.from.address
              : message.to[0]?.name ?? message.to[0]?.address ?? "onbekend";
            const Icon = inbound ? ArrowDownLeft : ArrowUpRight;
            const key = `${message.provider}-${message.mailboxId}-${message.externalMessageId}`;

            return (
              <div key={key} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                <Icon
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${inbound ? "text-accent-700" : "text-ink-tertiary"}`}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink-primary">{message.subject || "(geen onderwerp)"}</p>
                  <p className="mt-0.5 truncate text-xs text-ink-tertiary">{counterpart}</p>
                  {message.bodyPreview && <p className="mt-0.5 truncate text-xs text-ink-tertiary">{message.bodyPreview}</p>}
                  <p className="mt-0.5 text-[11px] text-ink-disabled">{message.mailboxAddress}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-xs text-ink-tertiary">{formatDateTime(message.occurredAt)}</span>
                  {message.webLink && (
                    <a
                      href={message.webLink}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-ink-tertiary hover:text-ink-secondary"
                      title="Origineel bericht openen"
                    >
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
