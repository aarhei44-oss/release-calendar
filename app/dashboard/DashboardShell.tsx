"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, Sparkles, PartyPopper, ChevronRight, Flame } from "lucide-react";
import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import { eventTitle } from "@/app/calendar/mapEvents";
import { formatEventDate, formatRelativeTime, statusBadgeClass } from "@/app/calendar/eventDisplay";
import { DEFAULT_DASHBOARD_CARD_ORDER, type DashboardCardId } from "./cards";

type SubscribedGame = { id: string; name: string };

export type TrendingEvent = { event: CalendarEvent; score: number };

type Props = {
  subscribedGames: SubscribedGame[];
  upcoming: CalendarEvent[];
  recentActivity: CalendarEvent[];
  /** Ranked by total positive/negative reaction count, already filtered to score > 0 and capped, see dashboard/page.tsx's topByScore. */
  mostHyped?: TrendingEvent[];
  mostMeh?: TrendingEvent[];
  /** Premium-configurable (see /profile); defaults to every card, in the default order. */
  cardOrder?: DashboardCardId[];
};

// Solid dots (not tinted backgrounds) so they stay legible against the dark
// hero banner these render on, in both light and dark mode.
const CHIP_DOT_COLORS = ["bg-blue-400", "bg-purple-400", "bg-emerald-400", "bg-amber-400", "bg-rose-400", "bg-teal-400"];

function chipDotColorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return CHIP_DOT_COLORS[hash % CHIP_DOT_COLORS.length];
}

const STATUS_ACCENT: Record<CalendarEvent["status"], string> = {
  RUMORED: "border-l-gray-300 dark:border-l-gray-700",
  ANNOUNCED: "border-l-blue-400 dark:border-l-blue-500",
  CONFIRMED: "border-l-green-400 dark:border-l-green-500",
  RELEASED: "border-l-purple-400 dark:border-l-purple-500",
  CANCELLED: "border-l-red-400 dark:border-l-red-500",
};

function EventCard({
  event,
  onSelect,
  showRelativeTime = false,
}: {
  event: CalendarEvent;
  onSelect: (id: string) => void;
  showRelativeTime?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid="event-row"
      onClick={() => onSelect(event.id)}
      className={`group flex w-full items-center justify-between gap-3 rounded-lg border border-l-4 border-gray-200 bg-white p-3.5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md dark:border-gray-800 dark:bg-gray-900 ${STATUS_ACCENT[event.status]}`}
    >
      <div className="min-w-0">
        <p className="truncate font-medium text-gray-900 dark:text-gray-100">{eventTitle(event)}</p>
        <p className="truncate text-sm text-gray-500 dark:text-gray-400">
          {event.productSet.install.package.name} ·{" "}
          {showRelativeTime ? `updated ${formatRelativeTime(event.updatedAt)}` : formatEventDate(event)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(event.status)}`}>
          {event.status}
        </span>
        <ChevronRight className="h-4 w-4 text-gray-300 transition-transform group-hover:translate-x-0.5 dark:text-gray-600" />
      </div>
    </button>
  );
}

function EventCardGrid({
  events,
  onSelect,
  showRelativeTime,
  emptyMessage,
}: {
  events: CalendarEvent[];
  onSelect: (id: string) => void;
  showRelativeTime?: boolean;
  emptyMessage: string;
}) {
  if (events.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-gray-200 py-8 text-center text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
        {emptyMessage}
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-2.5 @lg:grid-cols-2">
      {events.map((event) => (
        <EventCard key={event.id} event={event} onSelect={onSelect} showRelativeTime={showRelativeTime} />
      ))}
    </div>
  );
}

function TrendingEventRow({
  event,
  score,
  emoji,
  onSelect,
}: {
  event: CalendarEvent;
  score: number;
  emoji: string;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(event.id)}
      className="group flex w-full items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md dark:border-gray-800 dark:bg-gray-900"
    >
      <div className="min-w-0">
        <p className="truncate font-medium text-gray-900 dark:text-gray-100">{eventTitle(event)}</p>
        <p className="truncate text-sm text-gray-500 dark:text-gray-400">
          {event.productSet.install.package.name} · {formatEventDate(event)}
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-gray-700 dark:text-gray-300">
        <span>{emoji}</span>
        <span>{score}</span>
      </span>
    </button>
  );
}

function TrendingColumn({
  title,
  emoji,
  events,
  onSelect,
}: {
  title: string;
  emoji: string;
  events: TrendingEvent[];
  onSelect: (id: string) => void;
}) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-gray-500 dark:text-gray-400">
        {emoji} {title}
      </h3>
      {events.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-200 py-6 text-center text-sm text-gray-500 dark:border-gray-800 dark:text-gray-400">
          No reactions yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {events.map(({ event, score }) => (
            <TrendingEventRow key={event.id} event={event} score={score} emoji={emoji} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

function SectionHeading({ icon: Icon, title, subtitle }: { icon: typeof CalendarDays; title: string; subtitle?: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <Icon className="h-5 w-5 text-gray-400 dark:text-gray-500" />
      <h2 className="text-lg font-semibold">{title}</h2>
      {subtitle && <span className="text-sm text-gray-400 dark:text-gray-500">{subtitle}</span>}
    </div>
  );
}

export function DashboardShell({
  subscribedGames,
  upcoming,
  recentActivity,
  mostHyped = [],
  mostMeh = [],
  cardOrder = DEFAULT_DASHBOARD_CARD_ORDER,
}: Props) {
  const router = useRouter();
  const newlyConfirmed = recentActivity.filter((e) => e.status === "CONFIRMED");
  // getFilteredEvents (shared with /calendar and /subscriptions) deliberately
  // includes TBD events in any date-range query, since a TBD event has no
  // date to exclude it by -- that's the right call for a general calendar
  // view, but "Next 7 days" specifically promises near-term dates, so it
  // would be misleading to list undated events here (real example: decades
  // of TBD MTG reprints flooding a "next 7 days" list).
  const upcomingWithDates = upcoming.filter((e) => e.dateType !== "TBD");

  function openEvent(eventId: string) {
    router.push(`/calendar?tab=upcoming&eventId=${eventId}`);
  }

  if (subscribedGames.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 p-12 text-center">
        <p className="text-gray-600 dark:text-gray-400">
          You&rsquo;re not subscribed to any games yet, so there&rsquo;s nothing to show here.
        </p>
        <Link
          href="/subscriptions"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          Choose your games
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-8 p-4 lg:p-8">
      <div className="flex flex-col gap-5 rounded-xl bg-linear-to-br from-gray-900 to-gray-700 p-6 text-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Your dashboard</h1>
          <Link
            href="/subscriptions"
            className="rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium hover:bg-white/20"
          >
            Manage games
          </Link>
        </div>
        <div className="flex flex-wrap gap-6">
          <div>
            <p className="text-2xl font-bold">{upcomingWithDates.length}</p>
            <p className="text-sm text-white/70">Next 7 days</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{newlyConfirmed.length}</p>
            <p className="text-sm text-white/70">Newly confirmed</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{recentActivity.length}</p>
            <p className="text-sm text-white/70">Recent activity</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-white/10 pt-4">
          {subscribedGames.map((game) => (
            <span
              key={game.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-sm font-medium"
            >
              <span className={`h-2 w-2 rounded-full ${chipDotColorFor(game.name)}`} aria-hidden />
              {game.name}
            </span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        {cardOrder.map((cardId) => {
          switch (cardId) {
            case "upcoming":
              return (
                <section key={cardId} className="@container">
                  <SectionHeading icon={CalendarDays} title="Next 7 days" />
                  <EventCardGrid
                    events={upcomingWithDates}
                    onSelect={openEvent}
                    emptyMessage="Nothing with a set date in your subscriptions over the next 7 days."
                  />
                </section>
              );
            case "newlyConfirmed":
              // Unlike the other two cards, this one still hides itself when
              // empty even when enabled -- "newly confirmed" with nothing to
              // show reads as a broken section, not an empty state worth
              // seeing, same as before this became configurable.
              return newlyConfirmed.length > 0 ? (
                <section key={cardId} className="@container">
                  <SectionHeading icon={PartyPopper} title="Newly confirmed" />
                  <EventCardGrid events={newlyConfirmed} onSelect={openEvent} showRelativeTime emptyMessage="" />
                </section>
              ) : null;
            case "recentActivity":
              return (
                <section key={cardId} className="@container">
                  <SectionHeading icon={Sparkles} title="What's new" subtitle="scanned in the last 7 days" />
                  <EventCardGrid
                    events={recentActivity}
                    onSelect={openEvent}
                    showRelativeTime
                    emptyMessage="No activity on your subscriptions in the last 7 days."
                  />
                </section>
              );
            case "communityPulse":
              // Hides itself when nobody's reacted yet, same as newlyConfirmed --
              // two empty "no reactions yet" columns reads as broken, not empty.
              return mostHyped.length > 0 || mostMeh.length > 0 ? (
                <section key={cardId} className="@container">
                  <SectionHeading icon={Flame} title="Community pulse" subtitle="based on reactions" />
                  <div className="grid grid-cols-1 gap-4 @lg:grid-cols-2">
                    <TrendingColumn title="Most hyped" emoji={"\u{1F525}"} events={mostHyped} onSelect={openEvent} />
                    <TrendingColumn title="Getting meh reactions" emoji={"\u{1F614}"} events={mostMeh} onSelect={openEvent} />
                  </div>
                </section>
              ) : null;
          }
        })}
      </div>
    </div>
  );
}
