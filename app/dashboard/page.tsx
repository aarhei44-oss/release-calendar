import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import { listSubscriptions, getUpcomingForSubscriptions, getRecentActivityForSubscriptions } from "@/data/subscriptions/subscriptionsRepo";
import { getProfile } from "@/data/profile/profileRepo";
import { SignInPrompt } from "@/components/SignInPrompt";
import { DashboardShell } from "./DashboardShell";
import { DEFAULT_DASHBOARD_CARD_ORDER, resolveDashboardCardOrder } from "./cards";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return <SignInPrompt message="Sign in to see a dashboard of what's new for the games you follow." />;
  }

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

  return (
    <DashboardShell
      subscribedGames={subscriptions.map((s) => ({ id: s.tcgProfileInstallId, name: s.install.package.name }))}
      upcoming={upcoming}
      recentActivity={recentActivity}
      cardOrder={cardOrder}
    />
  );
}
