"use client";

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { getEventDetail } from "./actions";
import { formatEventDate, statusBadgeClass } from "./eventDisplay";
import { eventTitle } from "./mapEvents";
import { CommentsForEvent } from "./CommentsForEvent";

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
  const open = eventId !== null;
  const loading = eventId !== null && fetched?.eventId !== eventId;
  const detail = fetched?.eventId === eventId ? fetched.detail : null;

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
