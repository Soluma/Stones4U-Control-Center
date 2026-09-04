import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { formatTime } from "@/lib/format";
import { customerDisplayName } from "@/modules/crm/customer-identity";
import type { MyWorkAppointment } from "@/modules/dashboard/my-work";

export function MyWorkAppointmentsList({ appointments }: { appointments: MyWorkAppointment[] }) {
  return (
    <div>
      <h3 className="mb-3 text-sm font-medium text-ink-secondary">Afspraken vandaag</h3>
      {appointments.length === 0 ? (
        <p className="cc-card p-4 text-sm text-ink-tertiary">Geen afspraken vandaag.</p>
      ) : (
        <div className="cc-card divide-y divide-border-subtle">
          {appointments.map((appointment) => (
            <Link
              key={appointment.id}
              href={appointment.customerProfile ? `/customers/${appointment.customerProfile.id}?tab=appointments` : "#"}
              className="cc-table-row flex items-center gap-3 px-4 py-2.5 text-sm"
            >
              <CalendarClock className="h-3.5 w-3.5 shrink-0 text-ink-tertiary" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink-primary">{appointment.title}</span>
                <span className="block truncate text-xs text-ink-tertiary">
                  {formatTime(appointment.startsAt)}
                  {appointment.customerProfile ? ` · ${customerDisplayName(appointment.customerProfile)}` : ""}
                  {appointment.customerContact ? ` · ${appointment.customerContact.displayName}` : ""}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
