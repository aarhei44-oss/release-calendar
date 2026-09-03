import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import { listSubscriptions, getUpcomingForSubscriptions, getRecentActivityForSubscriptions } from "@/data/subscriptions/subscriptionsRepo";
import { SignInPrompt } from "@/components/SignInPrompt";
import { DashboardShell } from "./DashboardShell";

export default async function DashboardPage() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return <SignInPrompt message="Sign in to see a dashboard of what's new for the games you follow." />;
  }

  const [subscriptions, upcoming, recentActivity] = await Promise.all([
    listSubscriptions(session.user.id),
    getUpcomingForSubscriptions(session.user.id, 7),
    getRecentActivityForSubscriptions(session.user.id, 7),
  ]);

  return (
    <DashboardShell
      subscribedGames={subscriptions.map((s) => ({ id: s.tcgProfileInstallId, name: s.install.package.name }))}
      upcoming={upcoming}
      recentActivity={recentActivity}
    />
  );
}
