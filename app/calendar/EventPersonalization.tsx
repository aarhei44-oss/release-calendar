"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Heart, EyeOff } from "lucide-react";
import {
  getEventPersonalization,
  followEvent,
  unfollowEvent,
  dismissEvent,
  undismissEvent,
  savePersonalNote,
} from "./actions";

type PersonalizationState = Awaited<ReturnType<typeof getEventPersonalization>>;

type Props = {
  eventId: string;
  isPremium: boolean;
};

/**
 * Premium event-level personalization: follow (get notified about this one
 * event specifically, even without subscribing to the whole game), "not
 * interested" (hide it from this user's personalized views without
 * unsubscribing), and a private note (visible only to its author --
 * distinct from CommentsForEvent's public thread just above it in the
 * drawer). All three read/write through app/calendar/actions.ts, which
 * enforces requirePremium() server-side on every write.
 */
export function EventPersonalization({ eventId, isPremium }: Props) {
  const [state, setState] = useState<PersonalizationState | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaved, setNoteSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    getEventPersonalization(eventId).then((result) => {
      if (cancelled) return;
      setState(result);
      setNoteDraft(result.personalNote ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  function toggleFollow() {
    if (!state) return;
    const nextFollowed = !state.isFollowed;
    setState({ ...state, isFollowed: nextFollowed });
    startTransition(async () => {
      if (nextFollowed) await followEvent(eventId);
      else await unfollowEvent(eventId);
    });
  }

  function toggleDismiss() {
    if (!state) return;
    const nextDismissed = !state.isDismissed;
    setState({ ...state, isDismissed: nextDismissed });
    startTransition(async () => {
      if (nextDismissed) await dismissEvent(eventId);
      else await undismissEvent(eventId);
    });
  }

  function saveNote() {
    setNoteSaved(false);
    startTransition(async () => {
      await savePersonalNote(eventId, noteDraft);
      setNoteSaved(true);
    });
  }

  // Silent while loading -- the drawer already shows its own top-level
  // "Loading…" state for getEventDetail; this section just appears once
  // ready rather than showing a second, redundant loading indicator.
  if (!state) return null;

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Your notes</h3>
        {!isPremium && (
          <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">
            Premium
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={toggleFollow}
          disabled={!isPremium || isPending}
          className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
            state.isFollowed
              ? "border-pink-300 bg-pink-50 text-pink-700 dark:border-pink-800 dark:bg-pink-900/30 dark:text-pink-300"
              : "border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
          }`}
        >
          <Heart className={`h-3.5 w-3.5 ${state.isFollowed ? "fill-current" : ""}`} />
          {state.isFollowed ? "Following" : "Follow"}
        </button>
        <button
          type="button"
          onClick={toggleDismiss}
          disabled={!isPremium || isPending}
          className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
            state.isDismissed
              ? "border-gray-400 bg-gray-100 text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
              : "border-gray-300 text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
          }`}
        >
          <EyeOff className="h-3.5 w-3.5" />
          {state.isDismissed ? "Not interested" : "Mark not interested"}
        </button>
      </div>

      {!isPremium && (
        <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
          <Link href="/premium" className="text-blue-600 hover:underline dark:text-blue-400">
            Upgrade to Premium
          </Link>{" "}
          to follow events, hide ones you&rsquo;re not interested in, and add private notes.
        </p>
      )}

      <textarea
        value={noteDraft}
        onChange={(e) => {
          setNoteDraft(e.target.value);
          setNoteSaved(false);
        }}
        onBlur={saveNote}
        disabled={!isPremium || isPending}
        placeholder="Private note (only visible to you)"
        maxLength={2000}
        rows={2}
        className="mt-2 w-full rounded-md border border-gray-300 p-2 text-sm transition-colors focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100 dark:focus:border-gray-100 dark:focus:ring-gray-100"
      />
      {noteSaved && !isPending && <p className="mt-1 text-xs text-green-600 dark:text-green-400">Saved.</p>}
    </div>
  );
}
