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
 * Places EXACT events on the month grid. TBD events have no date to place
 * and are excluded here (business rule 6.1). RANGE and WINDOW events are
 * also excluded: spanning every day from start to end cluttered the grid --
 * a multi-week preorder window painting half the month, or a QUARTER/YEAR
 * WINDOW painting an entire quarter/year solid, as if the release were
 * confirmed for every one of those days rather than sometime within them.
 * They still surface in the Events List / Upcoming views, each as its own
 * row with its real (imprecise) date text -- see formatEventDate.
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
      return null;
    case "WINDOW":
      return null;
    case "TBD":
      return null;
  }
}

export function eventTitle(event: CalendarEvent): string {
  return event.productSet.name ?? event.productSet.code ?? "Untitled release";
}
