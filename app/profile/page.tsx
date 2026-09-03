import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import { getProfile } from "@/data/profile/profileRepo";
import { SignInPrompt } from "@/components/SignInPrompt";
import { ProfileForm, AlertsForm, DigestForm, LeadTimeReminderForm } from "./ProfileForm";
import { DashboardCardsForm } from "./DashboardCardsForm";
import { IcalFeedForm } from "./IcalFeedForm";
import { DEFAULT_DASHBOARD_CARD_ORDER, resolveDashboardCardOrder } from "@/app/dashboard/cards";

export default async function ProfilePage() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return <SignInPrompt message="Sign in to manage your profile and notification settings." />;
  }

  const profile = await getProfile(session.user.id);
  const timezones = Intl.supportedValuesOf("timeZone");

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-8 p-4">
      <h1 className="text-xl font-semibold">Profile</h1>
      <ProfileForm timezones={timezones} initialTimezone={profile.timezone} />
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
        initialToken={profile.icalToken}
        baseUrl={process.env.NEXTAUTH_URL ?? ""}
      />
    </div>
  );
}
