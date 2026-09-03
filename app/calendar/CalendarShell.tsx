"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SlidersHorizontal, Loader2 } from "lucide-react";
import type {
  ReleaseEventType,
  ReleaseStatus,
} from "@/app/generated/prisma/client";
import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import type { ReactionCounts } from "./eventDisplay";
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
  /** Keyed by event id; events with no reactions are simply absent. */
  reactionSummaries?: Record<string, ReactionCounts>;
};

export function CalendarShell({ parsed, events, installOptions, reactionSummaries }: Props) {
  const router = useRouter();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  // The drawer is pure client-side state, not a server round trip: EventDrawer
  // already fetches its own detail independently and doesn't use `events` at
  // all, so routing eventId through router.push (and re-fetching the entire
  // calendar's event list just to open a detail panel) was pure waste -- by
  // far the most frequent interaction on this page. history.replaceState
  // keeps the URL shareable/bookmarkable (integrates with Next's router per
  // its own docs) without triggering a server re-render. Deliberately
  // replaceState, not pushState: the back button won't step through
  // open/close as separate history entries, trading that off for simplicity
  // -- this page is about instant switching, not modal history semantics.
  const [eventId, setEventId] = useState<string | null>(parsed.eventId);

  function setEventIdShallow(id: string | null) {
    setEventId(id);
    window.history.replaceState(null, "", buildCalendarHref(parsed, { eventId: id }));
  }

  // Real navigations (tab/month/filter changes) genuinely need new data from
  // the server -- different date ranges or filters -- so there's no honest
  // way to make these zero-latency without speculatively prefetching every
  // tab's data. startTransition keeps the current content visible and
  // interactive while the new RSC payload streams in, instead of a blank
  // flash; isPending drives a small indicator so the switch still feels
  // acknowledged immediately. Carries the current (possibly shallow-updated)
  // eventId along, not parsed.eventId, so a drawer closed via
  // setEventIdShallow doesn't get resurrected by the next real navigation.
  function navigate(overrides: Parameters<typeof buildCalendarHref>[1]) {
    startTransition(() => {
      router.push(buildCalendarHref({ ...parsed, eventId }, overrides));
    });
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
          <div className="flex items-center gap-2">
            <Tabs
              active={parsed.tab}
              onChange={(tab: CalendarTab) => navigate({ tab })}
            />
            {isPending && (
              <Loader2
                className="h-4 w-4 animate-spin text-gray-400 dark:text-gray-500"
                aria-label="Loading"
              />
            )}
          </div>
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 lg:hidden dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800 dark:focus-visible:ring-gray-100"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filters
          </button>
        </div>

        <div className={`flex min-h-0 flex-1 flex-col overflow-hidden transition-opacity ${isPending ? "opacity-60" : ""}`}>
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
                  onSelectEvent={setEventIdShallow}
                  reactionSummaries={reactionSummaries}
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
                <EventsList events={events} onSelectEvent={setEventIdShallow} reactionSummaries={reactionSummaries} />
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
                  onSelectEvent={setEventIdShallow}
                  emptyMessage="Nothing upcoming in the next 90 days."
                  reactionSummaries={reactionSummaries}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      <EventDrawer eventId={eventId} onClose={() => setEventIdShallow(null)} />
    </div>
  );
}
