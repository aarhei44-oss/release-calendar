import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import { getProfile } from "@/data/profile/profileRepo";
import { SignInPrompt } from "@/components/SignInPrompt";
import { AlertsForm, DigestForm, LeadTimeReminderForm } from "./ProfileForm";
import { DashboardCardsForm } from "./DashboardCardsForm";
import { IcalFeedForm } from "./IcalFeedForm";
import { DEFAULT_DASHBOARD_CARD_ORDER, resolveDashboardCardOrder } from "@/app/dashboard/cards";

export default async function ProfilePage() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return <SignInPrompt message="Sign in to manage your profile and notification settings." />;
  }

  const profile = await getProfile(session.user.id);

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8 p-4">
      <h1 className="text-xl font-semibold">Profile</h1>
      {/* Timezone setting hidden for now -- release dates no longer honor it
          (they're calendar days, not real instants; see eventDisplay.ts).
          ProfileForm/updateTimezone left intact in case it's repurposed. */}
      <AlertsForm
        initialEmailAlertsEnabled={profile.emailAlertsEnabled}
        initialDiscordWebhookUrl={profile.discordWebhookUrl}
        initialDiscordAlertsEnabled={profile.discordAlertsEnabled}
      />
      <DashboardCardsForm
        isPremium={profile.isPremium}
        initialCardIds={
          profile.isPremium ? resolveDashboardCardOrder(profile.dashboardCardIds) : DEFAULT_DASHBOARD_CARD_ORDER
        }
      />
      <DigestForm
        isPremium={profile.isPremium}
        initialDigestEmailEnabled={profile.digestEmailEnabled}
        initialDigestFrequency={profile.digestFrequency}
      />
      <LeadTimeReminderForm isPremium={profile.isPremium} initialDays={profile.leadTimeReminderDays} />
      <IcalFeedForm
        isPremium={profile.isPremium}
        // A lapsed-premium user's old token would otherwise still reach the
        // client (props are serialized to the browser regardless of what
        // the UI renders from them) even though it no longer works -- the
        // feed route re-checks isPremium itself, but there's no reason to
        // send a stale credential-shaped value at all.
        initialToken={profile.isPremium ? profile.icalToken : null}
        baseUrl={process.env.NEXTAUTH_URL ?? ""}
      />
    </div>
  );
}
