"use client";

import { Calendar, dateFnsLocalizer, Views } from "react-big-calendar";
import { format, parse, startOfWeek, getDay } from "date-fns";
import { enUS } from "date-fns/locale";
import "react-big-calendar/lib/css/react-big-calendar.css";
import type { MappedCalendarEvent } from "./mapEvents";

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
};

export function ClientCalendar({ events, month, onNavigateMonth, onSelectEvent }: Props) {
  const [year, mon] = month.split("-").map(Number);
  const date = new Date(year, mon - 1, 1);

  return (
    <div className="h-[70vh] rounded-md border border-gray-200 bg-white p-2">
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
        popup
        toolbar={false}
        style={{ height: "100%" }}
      />
    </div>
  );
}
