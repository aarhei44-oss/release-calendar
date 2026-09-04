"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import { X, Lock } from "lucide-react";
import { useSession } from "next-auth/react";
import { googleCalendarEventUrl, outlookComEventUrl, office365EventUrl } from "@/lib/calendarLinks";
import { getEventDetail } from "./actions";
import { formatEventDate, statusBadgeClass } from "./eventDisplay";
import { eventTitle } from "./mapEvents";
import { CommentsForEvent } from "./CommentsForEvent";
import { EventPersonalization } from "./EventPersonalization";
import { EventReactions } from "./EventReactions";

type EventDetail = Awaited<ReturnType<typeof getEventDetail>>;

type Props = {
  eventId: string | null;
  onClose: () => void;
};

export function EventDrawer({ eventId, onClose }: Props) {
  const [fetched, setFetched] = useState<{
    eventId: string;
    detail: EventDetail;
  } | null>(null);
  const { data: session } = useSession();
  const open = eventId !== null;
  const loading = eventId !== null && fetched?.eventId !== eventId;
  const detail = fetched?.eventId === eventId ? fetched.detail : null;
  // Sourced from the just-fetched detail, not useSession() -- that hook's
  // cached session only refetches on window focus/an explicit update(),
  // so it can still say isPremium: false for a while right after a
  // premium status change in an already-open tab, even though the server
  // (and getEventDetail below, called fresh every time this drawer opens)
  // already agrees the viewer is premium. See actions.ts's viewerIsPremium.
  const isPremium = detail?.viewerIsPremium ?? false;

  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    getEventDetail(eventId).then((result) => {
      if (!cancelled) setFetched({ eventId, detail: result });
    });
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/30"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined}>
              <motion.aside
                className="fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-md flex-col overflow-y-auto bg-white p-6 shadow-xl dark:bg-gray-900"
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ duration: 0.3, ease: "easeInOut" }}
              >
                <Dialog.Title className="sr-only">Release event details</Dialog.Title>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Close"
                    className="self-end text-gray-400 transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:hover:text-gray-200 dark:focus-visible:ring-gray-100"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </Dialog.Close>

                {loading && <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">Loading…</p>}

                {!loading && !detail && (
                  <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">
                    This event could not be found.
                  </p>
                )}

                {!loading && detail && (
                  <div className="mt-2 flex flex-col gap-4">
                    <div>
                      <h2 className="text-lg font-semibold">{eventTitle(detail)}</h2>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {detail.productSet.install.package.name} · {detail.type}
                      </p>
                    </div>

                    {detail.productSet.hasDescription && (
                      <div>
                        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Description</h3>
                        {session?.user ? (
                          <p className="text-sm text-gray-600 dark:text-gray-400">{detail.productSet.description}</p>
                        ) : (
                          <p className="text-sm text-gray-500 dark:text-gray-400">
                            Sign in to view the set description.
                          </p>
                        )}
                      </div>
                    )}

                    {detail.productSet.hasMarketingImage &&
                      (isPremium && detail.productSet.imageUrl ? (
                        // Arbitrary external per-TCG source host, unknown ahead of time, so
                        // next/image's remotePatterns allowlist isn't workable here.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={detail.productSet.imageUrl}
                          alt={`${eventTitle(detail)} official marketing image`}
                          className="w-full rounded-lg object-cover"
                        />
                      ) : (
                        // No blurred preview of the real image here: the server
                        // (app/calendar/actions.ts) never sends imageUrl to a
                        // non-premium caller in the first place, so there's
                        // nothing to blur -- only a generic locked placeholder.
                        <div className="flex h-32 w-full flex-col items-center justify-center gap-1 rounded-lg bg-gray-100 text-center dark:bg-gray-800">
                          <Lock className="h-5 w-5 text-gray-400 dark:text-gray-500" />
                          <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
                            <Link href="/premium" className="text-blue-600 hover:underline dark:text-blue-400">
                              Upgrade to Premium
                            </Link>{" "}
                            to view official marketing images
                          </span>
                        </div>
                      ))}

                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-medium ${statusBadgeClass(detail.status)}`}
                      >
                        {detail.status}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        Confidence: {Math.round(detail.confidence * 100)}%
                      </span>
                      {detail.isManualOverride && (
                        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                          Manually overridden
                        </span>
                      )}
                    </div>

                    <div>
                      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Date</h3>
                      <p className="text-sm text-gray-900 dark:text-gray-100">
                        {formatEventDate(detail)}{" "}
                        <span className="text-gray-500 dark:text-gray-400">
                          ({detail.dateType.toLowerCase()})
                        </span>
                      </p>
                      {detail.manualNotes && (
                        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                          {detail.manualNotes}
                        </p>
                      )}
                    </div>

                    <EventReactions key={detail.id} eventId={detail.id} />

                    <AddToCalendar detail={detail} isPremium={isPremium} />

                    <div>
                      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        Source claims ({detail.sourceClaims.length})
                      </h3>
                      {detail.sourceClaims.length === 0 ? (
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          No source claims recorded yet.
                        </p>
                      ) : (
                        <ul className="mt-2 flex flex-col gap-2">
                          {detail.sourceClaims.map((claim) => (
                            <li
                              key={claim.id}
                              className="rounded-md border border-gray-200 p-2 text-sm dark:border-gray-700"
                            >
                              <div className="flex items-center justify-between">
                                <span className="font-medium">{claim.tier}</span>
                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                  {claim.disposition}
                                </span>
                              </div>
                              <a
                                href={claim.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="break-all text-xs text-blue-600 hover:underline dark:text-blue-400"
                              >
                                {claim.host ?? claim.url}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {session?.user && (
                      <EventPersonalization key={detail.id} eventId={detail.id} isPremium={isPremium} />
                    )}

                    <CommentsForEvent
                      key={detail.id}
                      eventId={detail.id}
                      initialComments={detail.userNotes}
                    />
                  </div>
                )}
              </motion.aside>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

const CALENDAR_LINK_CLASS =
  "rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800";

/**
 * Per-event "Add to Calendar" -- a premium feature (same tier as the
 * personal iCal feed, see app/profile/IcalFeedForm.tsx), not a data-security
 * gate: the event's date/title are already public elsewhere in this drawer.
 * Google/Outlook are plain external links (safe to compute client-side);
 * the .ics download still goes through a real server-side premium check
 * (app/api/events/[eventId]/ics/route.ts) since that one's a same-origin
 * request a free user could otherwise script around the UI.
 */
function AddToCalendar({ detail, isPremium }: { detail: NonNullable<EventDetail>; isPremium: boolean }) {
  if (!isPremium) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
        <Lock className="h-3.5 w-3.5 shrink-0" />
        <Link href="/premium" className="text-blue-600 hover:underline dark:text-blue-400">
          Upgrade to Premium
        </Link>{" "}
        to add this event to Google Calendar, Outlook, or download it as .ics
      </p>
    );
  }

  const googleUrl = googleCalendarEventUrl(detail);
  const outlookComUrl = outlookComEventUrl(detail);
  const office365Url = office365EventUrl(detail);
  if (!googleUrl || !outlookComUrl || !office365Url) return null;

  return (
    <div>
      <h3 className="mb-1.5 text-sm font-medium text-gray-700 dark:text-gray-300">Add to calendar</h3>
      <div className="flex flex-wrap gap-2">
        <a href={googleUrl} target="_blank" rel="noopener noreferrer" className={CALENDAR_LINK_CLASS}>
          Google Calendar
        </a>
        <a href={outlookComUrl} target="_blank" rel="noopener noreferrer" className={CALENDAR_LINK_CLASS}>
          Outlook.com
        </a>
        <a href={office365Url} target="_blank" rel="noopener noreferrer" className={CALENDAR_LINK_CLASS}>
          Office 365
        </a>
        <a href={`/api/events/${detail.id}/ics`} className={CALENDAR_LINK_CLASS}>
          Download .ics
        </a>
      </div>
    </div>
  );
}
