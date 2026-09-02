"use client";

import { useEffect, useRef, useState } from "react";
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
  const loading = eventId !== null && fetched?.eventId !== eventId;
  const detail = fetched?.eventId === eventId ? fetched.detail : null;
  const closeButtonRef = useRef<HTMLButtonElement>(null);

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

  useEffect(() => {
    if (!eventId) return;
    closeButtonRef.current?.focus();

    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [eventId, onClose]);

  if (!eventId) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close event details"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Release event details"
        className="relative flex h-full w-full max-w-md flex-col overflow-y-auto bg-white p-6 shadow-xl"
      >
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="self-end text-gray-400 hover:text-gray-700"
        >
          ✕
        </button>

        {loading && <p className="mt-4 text-sm text-gray-500">Loading…</p>}

        {!loading && !detail && (
          <p className="mt-4 text-sm text-gray-500">
            This event could not be found.
          </p>
        )}

        {!loading && detail && (
          <div className="mt-2 flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold">{eventTitle(detail)}</h2>
              <p className="text-sm text-gray-500">
                {detail.productSet.install.package.name} · {detail.type}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${statusBadgeClass(detail.status)}`}
              >
                {detail.status}
              </span>
              <span className="text-xs text-gray-500">
                Confidence: {Math.round(detail.confidence * 100)}%
              </span>
              {detail.isManualOverride && (
                <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                  Manually overridden
                </span>
              )}
            </div>

            <div>
              <h3 className="text-sm font-medium text-gray-700">Date</h3>
              <p className="text-sm text-gray-900">
                {formatEventDate(detail)}{" "}
                <span className="text-gray-500">
                  ({detail.dateType.toLowerCase()})
                </span>
              </p>
              {detail.manualNotes && (
                <p className="mt-1 text-sm text-gray-600">
                  {detail.manualNotes}
                </p>
              )}
            </div>

            <div>
              <h3 className="text-sm font-medium text-gray-700">
                Source claims ({detail.sourceClaims.length})
              </h3>
              {detail.sourceClaims.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No source claims recorded yet.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2">
                  {detail.sourceClaims.map((claim) => (
                    <li
                      key={claim.id}
                      className="rounded-md border border-gray-200 p-2 text-sm"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{claim.tier}</span>
                        <span className="text-xs text-gray-500">
                          {claim.disposition}
                        </span>
                      </div>
                      <a
                        href={claim.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-all text-xs text-blue-600 hover:underline"
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
      </aside>
    </div>
  );
}
