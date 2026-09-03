"use client";

import { useEffect, useState, useTransition } from "react";
import { useSession } from "next-auth/react";
import { REACTION_EMOJIS } from "./eventDisplay";
import { getEventReactionSummary, setEventReaction, clearEventReaction } from "./actions";

type ReactionSummary = Awaited<ReturnType<typeof getEventReactionSummary>>;

type Props = {
  eventId: string;
};

/**
 * Free-tier "hype" reactions (item 32): counts are public (visible to every
 * viewer, signed in or not) so a release's buzz is visible at a glance;
 * casting or clearing a reaction requires sign-in. One reaction per user per
 * event -- picking a new emoji replaces the old one rather than stacking.
 */
export function EventReactions({ eventId }: Props) {
  const { data: session } = useSession();
  const [summary, setSummary] = useState<ReactionSummary | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    getEventReactionSummary(eventId).then((result) => {
      if (!cancelled) setSummary(result);
    });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  function toggle(emoji: string) {
    if (!summary || isPending) return;
    const clearing = summary.myReaction === emoji;
    startTransition(async () => {
      const next = clearing ? await clearEventReaction(eventId) : await setEventReaction(eventId, emoji);
      setSummary(next);
    });
  }

  if (!summary) return null;

  const signedIn = !!session?.user;

  return (
    <div>
      <h3 className="mb-1.5 text-sm font-medium text-gray-700 dark:text-gray-300">Reactions</h3>
      <div className="flex flex-wrap gap-2">
        {REACTION_EMOJIS.map(({ emoji, label }) => {
          const count = summary.counts[emoji] ?? 0;
          const mine = summary.myReaction === emoji;
          return (
            <button
              key={emoji}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={mine}
              onClick={() => toggle(emoji)}
              disabled={!signedIn || isPending}
              className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-sm disabled:opacity-50 disabled:cursor-not-allowed ${
                mine
                  ? "border-blue-400 bg-blue-50 dark:border-blue-700 dark:bg-blue-900/30"
                  : "border-gray-300 hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-800"
              }`}
            >
              <span>{emoji}</span>
              {count > 0 && <span className="text-xs text-gray-600 dark:text-gray-400">{count}</span>}
            </button>
          );
        })}
      </div>
      {!signedIn && <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">Sign in to react.</p>}
    </div>
  );
}
