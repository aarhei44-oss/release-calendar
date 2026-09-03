import { getUserByIcalToken } from "@/data/profile/profileRepo";
import { getUpcomingForSubscriptions } from "@/data/subscriptions/subscriptionsRepo";
import { buildIcsFeed } from "@/lib/ical";
import { logEvent } from "@/lib/logger";

// A full year out -- calendar apps generally want a feed with real
// look-ahead, not just the "next 7 days" the dashboard shows.
const UPCOMING_WINDOW_DAYS = 365;

/**
 * Unauthenticated by design (external calendar clients don't send session
 * cookies) -- the opaque token in the URL *is* the access control, see
 * profileRepo.regenerateIcalToken. A missing token and a found-but-not-
 * premium token both return the same 404, deliberately not distinguishing
 * "wrong token" from "right token, lapsed premium" to a caller.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getUserByIcalToken(token);

  if (!user || !user.isPremium) {
    logEvent({ action: "ical.feed", outcome: "denied" });
    return new Response("Not found", { status: 404 });
  }

  const events = await getUpcomingForSubscriptions(user.id, UPCOMING_WINDOW_DAYS);
  const ics = buildIcsFeed(events);
  logEvent({ action: "ical.feed", outcome: "success", userId: user.id, eventCount: events.length });

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="release-watcher.ics"',
      // Calendar clients poll periodically on their own schedule -- no need
      // to hit the DB on every single request in between.
      "Cache-Control": "private, max-age=900",
    },
  });
}
