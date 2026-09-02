"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import { EventsList } from "@/app/calendar/EventsList";
import { subscribe, unsubscribe } from "./actions";

type InstallOption = { id: string; name: string };

type Props = {
  installs: InstallOption[];
  subscribedIds: string[];
  upcoming: CalendarEvent[];
};

export function SubscriptionsShell({ installs, subscribedIds, upcoming }: Props) {
  const router = useRouter();
  const [subscribed, setSubscribed] = useState(new Set(subscribedIds));
  const [isPending, startTransition] = useTransition();

  function toggle(installId: string) {
    const willSubscribe = !subscribed.has(installId);
    setSubscribed((prev) => {
      const next = new Set(prev);
      if (willSubscribe) next.add(installId);
      else next.delete(installId);
      return next;
    });

    startTransition(async () => {
      if (willSubscribe) {
        await subscribe(installId);
      } else {
        await unsubscribe(installId);
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-8 p-4">
      <section>
        <h2 className="mb-2 text-lg font-semibold">My subscriptions</h2>
        <ul className="flex flex-col gap-1">
          {installs.map((install) => (
            <li key={install.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={subscribed.has(install.id)}
                  disabled={isPending}
                  onChange={() => toggle(install.id)}
                />
                {install.name}
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Upcoming (next 30 days)</h2>
        <EventsList
          events={upcoming}
          onSelectEvent={(eventId) => router.push(`/calendar?tab=upcoming&eventId=${eventId}`)}
          emptyMessage="Nothing upcoming for your subscriptions in the next 30 days."
        />
      </section>
    </div>
  );
}
