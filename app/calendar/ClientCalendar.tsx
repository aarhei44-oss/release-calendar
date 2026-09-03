"use client";

import type { ReactNode } from "react";
import { Calendar, dateFnsLocalizer, Views, type EventWrapperProps } from "react-big-calendar";
import { format, parse, startOfWeek, getDay } from "date-fns";
import { enUS } from "date-fns/locale";
import "react-big-calendar/lib/css/react-big-calendar.css";
import "./rbc-theme.css";
import type { MappedCalendarEvent } from "./mapEvents";
import { topReactions, type ReactionCounts } from "./eventDisplay";

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { locale: enUS }),
  getDay,
  locales: { "en-US": enUS },
});

type Props = {
  events: MappedCalendarEvent[];
  month: string; // YYYY-MM
  onNavigateMonth: (month: string) => void;
  onSelectEvent: (eventId: string) => void;
  /** Keyed by event id; events with no reactions are simply absent. */
  reactionSummaries?: Record<string, ReactionCounts>;
};

export function ClientCalendar({ events, month, onNavigateMonth, onSelectEvent, reactionSummaries }: Props) {
  const [year, mon] = month.split("-").map(Number);
  const date = new Date(year, mon - 1, 1);

  return (
    <div className="h-full overflow-x-auto rounded-md border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-900">
      <div className="h-full min-w-160">
        <Calendar
          localizer={localizer}
          events={events}
          date={date}
          view={Views.MONTH}
          views={[Views.MONTH]}
          onNavigate={(newDate: Date) => {
            onNavigateMonth(`${newDate.getFullYear()}-${String(newDate.getMonth() + 1).padStart(2, "0")}`);
          }}
          onSelectEvent={(event: MappedCalendarEvent) => onSelectEvent(event.id)}
          eventPropGetter={(event: MappedCalendarEvent) => ({
            className: `rbc-event-status-${event.resource.status.toLowerCase()}`,
          })}
          components={{
            // eventWrapper (not event) so the badge sits outside .rbc-event-content,
            // which clips (overflow: hidden) anything meant to poke past its edges.
            eventWrapper: ({ event, children }: EventWrapperProps<MappedCalendarEvent> & { children?: ReactNode }) => {
              const reactions = topReactions(reactionSummaries?.[event.id], 3);
              const top = reactions[0];
              return (
                <div className="relative">
                  {children}
                  {top && (
                    <span
                      aria-hidden
                      title={reactions.map((r) => `${r.emoji} ${r.count}`).join(", ")}
                      className="absolute -top-1.5 -right-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-white text-[10px] leading-none shadow ring-1 ring-black/10 dark:bg-gray-900 dark:ring-white/20"
                    >
                      {top.emoji}
                    </span>
                  )}
                </div>
              );
            },
          }}
          popup
          toolbar={false}
          style={{ height: "100%" }}
        />
      </div>
    </div>
  );
}
