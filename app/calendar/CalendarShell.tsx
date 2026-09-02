"use client";

import { useRouter } from "next/navigation";
import type { ReleaseEventType, ReleaseStatus } from "@/app/generated/prisma/client";
import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import { Tabs } from "./Tabs";
import { FilterBar, type InstallOption } from "./FilterBar";
import { MonthSwitcher } from "./MonthSwitcher";
import { ClientCalendar } from "./ClientCalendar";
import { EventsList } from "./EventsList";
import { EventDrawer } from "./EventDrawer";
import { mapEventsForGrid } from "./mapEvents";
import { buildCalendarHref, type CalendarTab, type ParsedCalendarSearchParams } from "./searchParams";

type Props = {
  parsed: ParsedCalendarSearchParams;
  events: CalendarEvent[];
  installOptions: InstallOption[];
};

export function CalendarShell({ parsed, events, installOptions }: Props) {
  const router = useRouter();

  function navigate(overrides: Parameters<typeof buildCalendarHref>[1]) {
    router.push(buildCalendarHref(parsed, overrides));
  }

  function handleFiltersChange(patch: {
    installIds?: string[];
    types?: ReleaseEventType[];
    statuses?: ReleaseStatus[];
    search?: string;
  }) {
    navigate(patch);
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <Tabs active={parsed.tab} onChange={(tab: CalendarTab) => navigate({ tab })} />

      <FilterBar
        installOptions={installOptions}
        installIds={parsed.installIds}
        types={parsed.types}
        statuses={parsed.statuses}
        search={parsed.search}
        onChange={handleFiltersChange}
      />

      {parsed.tab === "calendar" && (
        <>
          <MonthSwitcher month={parsed.calMonth} onChange={(calMonth) => navigate({ calMonth })} />
          <ClientCalendar
            events={mapEventsForGrid(events)}
            month={parsed.calMonth}
            onNavigateMonth={(calMonth) => navigate({ calMonth })}
            onSelectEvent={(eventId) => navigate({ eventId })}
          />
        </>
      )}

      {parsed.tab === "list" && (
        <>
          <MonthSwitcher month={parsed.listMonth} onChange={(listMonth) => navigate({ listMonth })} />
          <EventsList events={events} onSelectEvent={(eventId) => navigate({ eventId })} />
        </>
      )}

      {parsed.tab === "upcoming" && (
        <EventsList
          events={events}
          onSelectEvent={(eventId) => navigate({ eventId })}
          emptyMessage="Nothing upcoming in the next 90 days."
        />
      )}

      <EventDrawer eventId={parsed.eventId} onClose={() => navigate({ eventId: null })} />
    </div>
  );
}
