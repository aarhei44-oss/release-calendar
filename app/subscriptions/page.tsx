import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import { listEnabledInstallsForFilters } from "@/data/calendar/calendarRepo";
import { listSubscriptions, getUpcomingForSubscriptions } from "@/data/subscriptions/subscriptionsRepo";
import { SignInPrompt } from "@/components/SignInPrompt";
import { SubscriptionsShell } from "./SubscriptionsShell";

export default async function SubscriptionsPage() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return <SignInPrompt />;
  }

  const [installs, subscriptions, upcoming] = await Promise.all([
    listEnabledInstallsForFilters(),
    listSubscriptions(session.user.id),
    getUpcomingForSubscriptions(session.user.id, 30),
  ]);

  return (
    <SubscriptionsShell
      installs={installs.map((install) => ({ id: install.id, name: install.package.name }))}
      subscribedIds={subscriptions.map((s) => s.tcgProfileInstallId)}
      upcoming={upcoming}
    />
  );
}
