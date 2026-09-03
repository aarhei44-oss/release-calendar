"use client";

import { useState, useTransition } from "react";
import { useSession } from "next-auth/react";
import { updateTimezone, updateEmailAlertsEnabled, updateDiscordWebhookUrl, updateDiscordAlertsEnabled } from "./actions";

type Props = {
  timezones: string[];
  initialTimezone: string | null;
};

export function ProfileForm({ timezones, initialTimezone }: Props) {
  const { update } = useSession();
  const [timezone, setTimezone] = useState(initialTimezone ?? "");
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  function handleChange(value: string) {
    setTimezone(value);
    setSaved(false);
    startTransition(async () => {
      await updateTimezone(value || null);
      await update();
      setSaved(true);
    });
  }

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold">Date &amp; time display</h2>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
        Release dates are shown in your browser&rsquo;s local timezone by default. Pick a specific one if you&rsquo;d
        rather always see dates in a fixed zone.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-gray-700 dark:text-gray-300">Timezone</span>
        <select
          value={timezone}
          disabled={isPending}
          onChange={(e) => handleChange(e.target.value)}
          className="w-full max-w-sm rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
        >
          <option value="">Browser default</option>
          {timezones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </label>
      {saved && !isPending && <p className="mt-2 text-sm text-green-600 dark:text-green-400">Saved.</p>}
    </section>
  );
}

type AlertsFormProps = {
  initialEmailAlertsEnabled: boolean;
  initialDiscordWebhookUrl: string | null;
  initialDiscordAlertsEnabled: boolean;
};

export function AlertsForm({
  initialEmailAlertsEnabled,
  initialDiscordWebhookUrl,
  initialDiscordAlertsEnabled,
}: AlertsFormProps) {
  const [emailAlertsEnabled, setEmailAlertsEnabled] = useState(initialEmailAlertsEnabled);
  const [isPending, startTransition] = useTransition();

  const [webhookUrl, setWebhookUrl] = useState(initialDiscordWebhookUrl ?? "");
  const [discordAlertsEnabled, setDiscordAlertsEnabled] = useState(initialDiscordAlertsEnabled);
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const [webhookSaved, setWebhookSaved] = useState(false);
  const [isDiscordPending, startDiscordTransition] = useTransition();

  function handleEmailChange(enabled: boolean) {
    setEmailAlertsEnabled(enabled);
    startTransition(async () => {
      await updateEmailAlertsEnabled(enabled);
    });
  }

  function saveWebhookUrl() {
    setWebhookError(null);
    setWebhookSaved(false);
    startDiscordTransition(async () => {
      try {
        await updateDiscordWebhookUrl(webhookUrl.trim() || null);
        setWebhookSaved(true);
      } catch {
        setWebhookError("That doesn't look like a Discord webhook URL.");
      }
    });
  }

  function handleDiscordAlertsChange(enabled: boolean) {
    setDiscordAlertsEnabled(enabled);
    startDiscordTransition(async () => {
      await updateDiscordAlertsEnabled(enabled);
    });
  }

  return (
    <section className="flex flex-col gap-5">
      <div>
        <h2 className="mb-1 text-lg font-semibold">Alerts</h2>
        <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
          Get notified the moment a subscribed game gets a new or changed release, or progresses toward release.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={emailAlertsEnabled}
            disabled={isPending}
            onChange={(e) => handleEmailChange(e.target.checked)}
          />
          Email me immediately when a subscribed game changes
        </label>
      </div>

      <div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-gray-700 dark:text-gray-300">Discord webhook URL</span>
          <input
            type="url"
            value={webhookUrl}
            placeholder="https://discord.com/api/webhooks/..."
            disabled={isDiscordPending}
            onChange={(e) => {
              setWebhookUrl(e.target.value);
              setWebhookSaved(false);
              setWebhookError(null);
            }}
            onBlur={saveWebhookUrl}
            className="w-full max-w-sm rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
          />
        </label>
        {webhookError && <p className="mt-1 text-sm text-red-600 dark:text-red-400">{webhookError}</p>}
        {webhookSaved && !webhookError && <p className="mt-1 text-sm text-green-600 dark:text-green-400">Saved.</p>}
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={discordAlertsEnabled}
            disabled={isDiscordPending}
            onChange={(e) => handleDiscordAlertsChange(e.target.checked)}
          />
          Post alerts to this Discord webhook
        </label>
      </div>
    </section>
  );
}
