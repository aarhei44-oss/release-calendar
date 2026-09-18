import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import { listSubscriptions, getUpcomingForSubscriptions, getRecentActivityForSubscriptions } from "@/data/subscriptions/subscriptionsRepo";
import { getProfile } from "@/data/profile/profileRepo";
import { getReactionScoresForEvents } from "@/data/events/eventPersonalizationRepo";
import { getLatestNewsTeaser } from "@/data/news/newsRepo";
import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import { SignInPrompt } from "@/components/SignInPrompt";
import { stripPremiumImageUrls } from "@/app/calendar/eventDisplay";
import { DashboardShell, type TrendingEvent } from "./DashboardShell";
import { DEFAULT_DASHBOARD_CARD_ORDER, resolveDashboardCardOrder } from "./cards";

const TRENDING_LIST_SIZE = 3;
const DASHBOARD_NEWS_SIZE = 5;

type Props = {
  searchParams: Promise<{ newsSubs?: string }>;
};

/** Ranks a pool of events by reaction score and keeps the top N with a positive score in that direction. */
function topByScore(events: CalendarEvent[], scores: Map<string, { positive: number; negative: number }>, key: "positive" | "negative"): TrendingEvent[] {
  return events
    .map((event) => ({ event, score: scores.get(event.id)?.[key] ?? 0 }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TRENDING_LIST_SIZE);
}

export default async function DashboardPage({ searchParams }: Props) {
  const [session, { newsSubs }] = await Promise.all([getServerSession(authOptions), searchParams]);

  if (!session?.user) {
    return <SignInPrompt message="Sign in to see a dashboard of what's new for the games you follow." />;
  }

  const newsOnlySubscribed = newsSubs === "1";

  const [subscriptions, upcoming, recentActivity, profile] = await Promise.all([
    listSubscriptions(session.user.id),
    getUpcomingForSubscriptions(session.user.id, 7),
    getRecentActivityForSubscriptions(session.user.id, 7),
    getProfile(session.user.id),
  ]);

  // A free user's customization (if any leftover from a lapsed premium
  // period) is ignored, not just hidden -- the feature itself is premium.
  const cardOrder = profile.isPremium
    ? resolveDashboardCardOrder(profile.dashboardCardIds)
    : DEFAULT_DASHBOARD_CARD_ORDER;

  const strippedUpcoming = stripPremiumImageUrls(upcoming, profile.isPremium);
  const strippedRecentActivity = stripPremiumImageUrls(recentActivity, profile.isPremium);

  // Reaction counts are public (see EventReactions), so this pool is just
  // "events already on this dashboard" -- no separate premium/visibility gate.
  const trendingPool = new Map([...strippedUpcoming, ...strippedRecentActivity].map((e) => [e.id, e]));
  const reactionScores = await getReactionScoresForEvents([...trendingPool.keys()]);
  const pooledEvents = [...trendingPool.values()];

  // News is a paid feature (see /news) -- gate the fetch itself, not just
  // the rendered card, the same lesson this repo already learned once for
  // ProductSet.imageUrl (see stripPremiumImageUrls above). A non-premium
  // session gets no news items in its props at all, not just a hidden card.
  const subscribedInstallIds = subscriptions.map((s) => s.tcgProfileInstallId);
  const newsFilterIds = newsOnlySubscribed ? subscribedInstallIds : undefined;
  const latestNews = profile.isPremium
    ? await getLatestNewsTeaser(DASHBOARD_NEWS_SIZE, newsFilterIds).catch(() => [])
    : [];

  return (
    <DashboardShell
      subscribedGames={subscriptions.map((s) => ({ id: s.tcgProfileInstallId, name: s.install.package.name }))}
      upcoming={strippedUpcoming}
      recentActivity={strippedRecentActivity}
      mostHyped={topByScore(pooledEvents, reactionScores, "positive")}
      mostMeh={topByScore(pooledEvents, reactionScores, "negative")}
      latestNews={latestNews}
      newsOnlySubscribed={newsOnlySubscribed}
      cardOrder={cardOrder}
    />
  );
}
