"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  updateTimezone,
  updateEmailAlertsEnabled,
  updateDiscordWebhookUrl,
  updateDiscordAlertsEnabled,
  updateDigestEmailEnabled,
  updateDigestFrequency,
  updateLeadTimeReminderDays,
} from "./actions";

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

type DigestFormProps = {
  isPremium: boolean;
  initialDigestEmailEnabled: boolean;
  initialDigestFrequency: "DAILY" | "WEEKLY";
};

export function DigestForm({ isPremium, initialDigestEmailEnabled, initialDigestFrequency }: DigestFormProps) {
  const [enabled, setEnabled] = useState(initialDigestEmailEnabled);
  const [frequency, setFrequency] = useState(initialDigestFrequency);
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  function handleEnabledChange(next: boolean) {
    setEnabled(next);
    setSaved(false);
    startTransition(async () => {
      await updateDigestEmailEnabled(next);
      setSaved(true);
    });
  }

  function handleFrequencyChange(next: "DAILY" | "WEEKLY") {
    setFrequency(next);
    setSaved(false);
    startTransition(async () => {
      await updateDigestFrequency(next);
      setSaved(true);
    });
  }

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-lg font-semibold">Digest email</h2>
        {!isPremium && (
          <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">
            Premium
          </span>
        )}
      </div>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
        A roundup of upcoming releases across your subscriptions, sent on a schedule instead of one email per change.
        {!isPremium && (
          <>
            {" "}
            <Link href="/premium" className="text-blue-600 hover:underline dark:text-blue-400">
              Upgrade to Premium
            </Link>{" "}
            to enable this.
          </>
        )}
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!isPremium || isPending}
          onChange={(e) => handleEnabledChange(e.target.checked)}
        />
        Send me a digest email
      </label>
      <fieldset className="mt-2 flex items-center gap-4 text-sm" disabled={!isPremium || !enabled || isPending}>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="digestFrequency"
            checked={frequency === "DAILY"}
            onChange={() => handleFrequencyChange("DAILY")}
          />
          Daily
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="digestFrequency"
            checked={frequency === "WEEKLY"}
            onChange={() => handleFrequencyChange("WEEKLY")}
          />
          Weekly
        </label>
      </fieldset>
      {saved && !isPending && <p className="mt-2 text-sm text-green-600 dark:text-green-400">Saved.</p>}
    </section>
  );
}

export function LeadTimeReminderForm({
  isPremium,
  initialDays,
}: {
  isPremium: boolean;
  initialDays: number | null;
}) {
  const [enabled, setEnabled] = useState(initialDays !== null);
  const [days, setDays] = useState(initialDays ?? 7);
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  function persist(nextEnabled: boolean, nextDays: number) {
    setSaved(false);
    startTransition(async () => {
      await updateLeadTimeReminderDays(nextEnabled ? nextDays : null);
      setSaved(true);
    });
  }

  function handleEnabledChange(next: boolean) {
    setEnabled(next);
    persist(next, days);
  }

  function handleDaysChange(next: number) {
    setDays(next);
    if (enabled) persist(true, next);
  }

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-lg font-semibold">Lead-time reminders</h2>
        {!isPremium && (
          <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">
            Premium
          </span>
        )}
      </div>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
        Get a reminder a set number of days before a subscribed release, instead of only when something changes.
        {!isPremium && (
          <>
            {" "}
            <Link href="/premium" className="text-blue-600 hover:underline dark:text-blue-400">
              Upgrade to Premium
            </Link>{" "}
            to enable this.
          </>
        )}
      </p>
      <div className="flex items-center gap-2 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!isPremium || isPending}
            onChange={(e) => handleEnabledChange(e.target.checked)}
          />
          Remind me
        </label>
        <input
          type="number"
          min={1}
          max={365}
          value={days}
          disabled={!isPremium || !enabled || isPending}
          onChange={(e) => handleDaysChange(Math.max(1, Math.min(365, Number(e.target.value) || 1)))}
          className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
        <span>day{days === 1 ? "" : "s"} before release</span>
      </div>
      {saved && !isPending && <p className="mt-2 text-sm text-green-600 dark:text-green-400">Saved.</p>}
    </section>
  );
}
