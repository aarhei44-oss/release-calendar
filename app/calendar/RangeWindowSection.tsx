"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import { EventsList } from "./EventsList";
import type { ReactionCounts } from "./eventDisplay";

type Props = {
  /** RANGE/WINDOW events for the month in view -- see mapEventsForGrid for why they can't be placed on the grid itself. */
  events: CalendarEvent[];
  onSelectEvent: (eventId: string) => void;
  reactionSummaries?: Record<string, ReactionCounts>;
};

/**
 * A collapsible strip beneath the calendar grid for RANGE/WINDOW events --
 * the ones mapEventsForGrid deliberately excludes from the grid because they
 * have no single day to occupy. Without this they were only reachable via
 * the separate Events List / Upcoming tabs; this keeps them visible from the
 * calendar tab itself, just not painted across every day they might fall on.
 */
export function RangeWindowSection({ events, onSelectEvent, reactionSummaries }: Props) {
  const [expanded, setExpanded] = useState(false);
  const flexible = events.filter((event) => event.dateType === "RANGE" || event.dateType === "WINDOW");

  if (flexible.length === 0) return null;

  return (
    <div className="shrink-0 rounded-md border border-gray-200 dark:border-gray-800">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-900 dark:text-gray-200 dark:hover:bg-gray-900 dark:focus-visible:ring-gray-100"
      >
        <span>Flexible-date releases ({flexible.length})</span>
        {expanded ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
      </button>
      {expanded && (
        <div className="max-h-64 overflow-y-auto border-t border-gray-200 px-3 dark:border-gray-800">
          <EventsList events={flexible} onSelectEvent={onSelectEvent} reactionSummaries={reactionSummaries} />
        </div>
      )}
    </div>
  );
}
