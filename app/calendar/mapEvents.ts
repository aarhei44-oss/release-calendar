import type { CalendarEvent } from "@/data/calendar/calendarRepo";

export type MappedCalendarEvent = {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  resource: CalendarEvent;
};

/**
 * Places EXACT/RANGE/WINDOW events on the month grid. TBD events have no
 * date to place and are excluded here (business rule 6.1) -- they still
 * surface in the Events List / Upcoming views.
 */
export function mapEventsForGrid(events: CalendarEvent[]): MappedCalendarEvent[] {
  const mapped: MappedCalendarEvent[] = [];

  for (const event of events) {
    const span = dateSpanFor(event);
    if (!span) continue;

    mapped.push({
      id: event.id,
      title: eventTitle(event),
      start: span.start,
      end: span.end,
      allDay: true,
      resource: event,
    });
  }

  return mapped;
}

function dateSpanFor(event: CalendarEvent): { start: Date; end: Date } | null {
  switch (event.dateType) {
    case "EXACT":
      return event.dateExact ? { start: event.dateExact, end: event.dateExact } : null;
    case "RANGE":
      return event.dateStart && event.dateEnd
        ? { start: event.dateStart, end: event.dateEnd }
        : null;
    case "WINDOW":
      return event.windowStart && event.windowEnd
        ? { start: event.windowStart, end: event.windowEnd }
        : null;
    case "TBD":
      return null;
  }
}

export function eventTitle(event: CalendarEvent): string {
  return event.productSet.name ?? event.productSet.code ?? "Untitled release";
}
