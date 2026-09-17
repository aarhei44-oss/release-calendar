import { headers } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import { AdsenseAutoAds } from "@/components/AdsenseAutoAds";
import { getFilteredEvents } from "./actions";
import { listEnabledInstallsForFilters, type CalendarFilters } from "@/data/calendar/calendarRepo";
import { listSubscriptions } from "@/data/subscriptions/subscriptionsRepo";
import { getReactionSummariesForEvents } from "@/data/events/eventPersonalizationRepo";
import {
  parseCalendarSearchParams,
  monthRange,
  DEFAULT_RELEASE_EVENT_TYPES,
  type RawSearchParams,
} from "./searchParams";
import { CalendarShell } from "./CalendarShell";

type Props = {
  searchParams: Promise<RawSearchParams>;
};

/**
 * The date half of each tab's query. The Unconfirmed tab is the one with no
 * range at all: it asks for TBD events, which have no date to bound a range
 * with -- see calendarRepo's buildWhere, where TBD is excluded from every
 * from/to query precisely so those events surface here and nowhere else.
 */
function dateQueryFor(parsed: ReturnType<typeof parseCalendarSearchParams>): Pick<CalendarFilters, "from" | "to" | "dateTypes"> {
  if (parsed.tab === "unconfirmed") return { dateTypes: ["TBD"] };
  if (parsed.tab === "list") return monthRange(parsed.listMonth);
  if (parsed.tab === "upcoming") {
    const from = new Date();
    const to = new Date();
    to.setDate(to.getDate() + 90);
    return { from, to };
  }
  return monthRange(parsed.calMonth);
}

// Phones get the List tab by default (a bare /calendar visit only) --
// the Calendar tab's month grid has much less room to work with there.
// A false positive/negative just lands on a different (still usable) tab,
// so sniffing the UA for this is a low-stakes, no-client-JS way to steer
// the initial render without a flash of the other tab's content.
const MOBILE_USER_AGENT = /Mobi|Android|iPhone|iPod/i;

export default async function CalendarPage({ searchParams }: Props) {
  const rawParams = await searchParams;
  const userAgent = (await headers()).get("user-agent") ?? "";
  const defaultTab = MOBILE_USER_AGENT.test(userAgent) ? "list" : "calendar";
  const parsed = parseCalendarSearchParams(rawParams, defaultTab);

  // A completely bare /calendar visit (no query string at all) gets a couple
  // of defaults baked into `parsed` instead of the wide-open "everything"
  // view: promos are hidden (DEFAULT_RELEASE_EVENT_TYPES), and a signed-in
  // visitor's subscribed games are pre-selected instead of every install.
  // Once any tab/month/filter interaction happens, CalendarShell's
  // navigate() always carries those params forward explicitly, so this only
  // ever fires on a fresh visit, never overriding a filter the user has
  // touched (including clearing installs back to "all games" or checking
  // "Promo" back on).
  const session = await getServerSession(authOptions);
  if (Object.keys(rawParams).length === 0) {
    parsed.types = DEFAULT_RELEASE_EVENT_TYPES;
    if (session?.user) {
      const subscriptions = await listSubscriptions(session.user.id);
      if (subscriptions.length > 0) {
        parsed.installIds = subscriptions.map((s) => s.tcgProfileInstallId);
      }
    }
  }

  const [events, installs] = await Promise.all([
    getFilteredEvents({
      installIds: parsed.installIds,
      types: parsed.types,
      statuses: parsed.statuses,
      search: parsed.search || undefined,
      ...dateQueryFor(parsed),
    }),
    listEnabledInstallsForFilters(),
  ]);

  const installOptions = installs.map((install) => ({ id: install.id, name: install.package.name }));

  // Reaction counts are public (see EventReactions), so no premium/anon gate
  // is needed here -- just a plain-object copy of the Map since Server
  // Component props must be JSON-serializable for the client boundary.
  const reactionSummaries = Object.fromEntries(
    await getReactionSummariesForEvents(events.map((e) => e.id)),
  );

  // Google's policy explicitly names empty search-result screens as an
  // example of "ads without publisher-content" -- a filtered/searched view
  // with zero matches is that same shape, so ads are withheld right along
  // with it rather than only ever being gated on the route.
  return (
    <>
      {events.length > 0 && <AdsenseAutoAds />}
      <CalendarShell
        parsed={parsed}
        events={events}
        installOptions={installOptions}
        reactionSummaries={reactionSummaries}
      />
    </>
  );
}
