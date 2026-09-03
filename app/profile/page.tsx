import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import { getProfile } from "@/data/profile/profileRepo";
import { SignInPrompt } from "@/components/SignInPrompt";
import { ProfileForm, AlertsForm } from "./ProfileForm";

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
    </div>
  );
}
