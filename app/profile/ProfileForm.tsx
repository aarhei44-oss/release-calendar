"use client";

import { useState, useTransition } from "react";
import { useSession } from "next-auth/react";
import { updateTimezone, updateEmailAlertsEnabled } from "./actions";

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

export function AlertsForm({ initialEmailAlertsEnabled }: { initialEmailAlertsEnabled: boolean }) {
  const [emailAlertsEnabled, setEmailAlertsEnabled] = useState(initialEmailAlertsEnabled);
  const [isPending, startTransition] = useTransition();

  function handleChange(enabled: boolean) {
    setEmailAlertsEnabled(enabled);
    startTransition(async () => {
      await updateEmailAlertsEnabled(enabled);
    });
  }

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold">Alerts</h2>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
        Get notified the moment a subscribed game gets a new or changed release, or progresses toward release.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={emailAlertsEnabled}
          disabled={isPending}
          onChange={(e) => handleChange(e.target.checked)}
        />
        Email me immediately when a subscribed game changes
      </label>
    </section>
  );
}
