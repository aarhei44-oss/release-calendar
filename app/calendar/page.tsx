import { headers } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import { getFilteredEvents } from "./actions";
import { listEnabledInstallsForFilters } from "@/data/calendar/calendarRepo";
import { listSubscriptions } from "@/data/subscriptions/subscriptionsRepo";
import { getReactionSummariesForEvents } from "@/data/events/eventPersonalizationRepo";
import { parseCalendarSearchParams, monthRange, type RawSearchParams } from "./searchParams";
import { CalendarShell } from "./CalendarShell";

type Props = {
  searchParams: Promise<RawSearchParams>;
};

function dateRangeFor(parsed: ReturnType<typeof parseCalendarSearchParams>) {
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

  // A signed-in visitor landing on a completely bare /calendar (no query
  // string at all) gets their subscribed games pre-selected instead of every
  // install, so the page opens already relevant to them. Once any tab/month/
  // filter interaction happens, CalendarShell's navigate() always carries
  // those params forward explicitly, so this only ever fires on a fresh
  // visit, never overriding a filter the user has touched (including
  // clearing it back to "all games").
  const session = await getServerSession(authOptions);
  if (session?.user && Object.keys(rawParams).length === 0) {
    const subscriptions = await listSubscriptions(session.user.id);
    if (subscriptions.length > 0) {
      parsed.installIds = subscriptions.map((s) => s.tcgProfileInstallId);
    }
  }

  const { from, to } = dateRangeFor(parsed);

  const [events, installs] = await Promise.all([
    getFilteredEvents({
      installIds: parsed.installIds,
      types: parsed.types,
      statuses: parsed.statuses,
      search: parsed.search || undefined,
      from,
      to,
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

  return (
    <CalendarShell
      parsed={parsed}
      events={events}
      installOptions={installOptions}
      reactionSummaries={reactionSummaries}
    />
  );
}
