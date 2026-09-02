"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import type {
  ReleaseEventType,
  ReleaseStatus,
} from "@/app/generated/prisma/client";
import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import { Tabs, tabPanelId } from "./Tabs";
import { type InstallOption } from "./FilterBar";
import { FilterSidebar } from "./FilterSidebar";
import { MonthSwitcher } from "./MonthSwitcher";
import { ClientCalendar } from "./ClientCalendar";
import { EventsList } from "./EventsList";
import { EventDrawer } from "./EventDrawer";
import { mapEventsForGrid } from "./mapEvents";
import {
  buildCalendarHref,
  type CalendarTab,
  type ParsedCalendarSearchParams,
} from "./searchParams";

type Props = {
  parsed: ParsedCalendarSearchParams;
  events: CalendarEvent[];
  installOptions: InstallOption[];
};

export function CalendarShell({ parsed, events, installOptions }: Props) {
  const router = useRouter();
  const [filtersOpen, setFiltersOpen] = useState(false);

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
    <div className="flex h-full min-h-0 overflow-hidden">
      <FilterSidebar
        installOptions={installOptions}
        installIds={parsed.installIds}
        types={parsed.types}
        statuses={parsed.statuses}
        search={parsed.search}
        onChange={handleFiltersChange}
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-between gap-2 p-4 pb-0">
          <Tabs
            active={parsed.tab}
            onChange={(tab: CalendarTab) => navigate({ tab })}
          />
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 lg:hidden dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800 dark:focus-visible:ring-gray-100"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filters
          </button>
        </div>

        {parsed.tab === "calendar" && (
          <div
            id={tabPanelId("calendar")}
            role="tabpanel"
            aria-labelledby="calendar-tab-calendar"
            tabIndex={0}
            className="flex h-full min-h-0 flex-col gap-4 overflow-hidden p-4"
          >
            <MonthSwitcher
              month={parsed.calMonth}
              onChange={(calMonth) => navigate({ calMonth })}
            />
            <div className="min-h-0 flex-1">
              <ClientCalendar
                events={mapEventsForGrid(events)}
                month={parsed.calMonth}
                onNavigateMonth={(calMonth) => navigate({ calMonth })}
                onSelectEvent={(eventId) => navigate({ eventId })}
              />
            </div>
          </div>
        )}

        {parsed.tab === "list" && (
          <div
            id={tabPanelId("list")}
            role="tabpanel"
            aria-labelledby="calendar-tab-list"
            tabIndex={0}
            className="flex h-full min-h-0 flex-col gap-4 overflow-hidden p-4"
          >
            <MonthSwitcher
              month={parsed.listMonth}
              onChange={(listMonth) => navigate({ listMonth })}
            />
            <div data-testid="tabpanel-scroll" className="min-h-0 flex-1 overflow-y-auto">
              <EventsList
                events={events}
                onSelectEvent={(eventId) => navigate({ eventId })}
              />
            </div>
          </div>
        )}

        {parsed.tab === "upcoming" && (
          <div
            id={tabPanelId("upcoming")}
            role="tabpanel"
            aria-labelledby="calendar-tab-upcoming"
            tabIndex={0}
            className="flex h-full min-h-0 flex-col overflow-hidden p-4"
          >
            <div data-testid="tabpanel-scroll" className="min-h-0 flex-1 overflow-y-auto">
              <EventsList
                events={events}
                onSelectEvent={(eventId) => navigate({ eventId })}
                emptyMessage="Nothing upcoming in the next 90 days."
              />
            </div>
          </div>
        )}
      </div>

      <EventDrawer
        eventId={parsed.eventId}
        onClose={() => navigate({ eventId: null })}
      />
    </div>
  );
}
