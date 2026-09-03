"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { googleCalendarSubscribeUrl, outlookComSubscribeUrl, office365SubscribeUrl } from "@/lib/calendarLinks";
import { regenerateIcalToken } from "./actions";

const SUBSCRIBE_LINK_CLASS =
  "rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800";
const FEED_NAME = "Release Watcher";

export function IcalFeedForm({
  isPremium,
  initialToken,
  baseUrl,
}: {
  isPremium: boolean;
  initialToken: string | null;
  baseUrl: string;
}) {
  const [token, setToken] = useState(initialToken);
  const [isPending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  const feedUrl = token ? `${baseUrl}/api/ical/${token}/feed.ics` : null;

  function generate() {
    setCopied(false);
    startTransition(async () => {
      const newToken = await regenerateIcalToken();
      setToken(newToken);
    });
  }

  async function copyToClipboard() {
    if (!feedUrl) return;
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);
    } catch {
      // Clipboard API can fail (permissions, non-secure context) -- the URL
      // is still shown and selectable, so this just skips the "Copied!" cue.
    }
  }

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-lg font-semibold">Personal calendar feed</h2>
        {!isPremium && (
          <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">
            Premium
          </span>
        )}
      </div>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
        A private iCal feed of your subscriptions&rsquo; upcoming releases -- import it into Google, Apple, or Outlook
        Calendar.
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
      {isPremium && feedUrl && (
        <>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={feedUrl}
              onFocus={(e) => e.target.select()}
              className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
            <button
              type="button"
              onClick={copyToClipboard}
              className="shrink-0 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <a
              href={googleCalendarSubscribeUrl(feedUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className={SUBSCRIBE_LINK_CLASS}
            >
              Add to Google Calendar
            </a>
            <a
              href={outlookComSubscribeUrl(feedUrl, FEED_NAME)}
              target="_blank"
              rel="noopener noreferrer"
              className={SUBSCRIBE_LINK_CLASS}
            >
              Add to Outlook.com
            </a>
            <a
              href={office365SubscribeUrl(feedUrl, FEED_NAME)}
              target="_blank"
              rel="noopener noreferrer"
              className={SUBSCRIBE_LINK_CLASS}
            >
              Add to Office 365
            </a>
          </div>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            Apple Calendar: paste the URL above into Settings &rarr; Add subscription calendar.
          </p>
        </>
      )}
      {isPremium && (
        <button
          type="button"
          onClick={generate}
          disabled={isPending}
          className="mt-2 text-sm text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
        >
          {token ? "Regenerate feed URL" : "Generate feed URL"}
        </button>
      )}
      {isPremium && token && (
        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
          Regenerating immediately invalidates the URL above.
        </p>
      )}
    </section>
  );
}
