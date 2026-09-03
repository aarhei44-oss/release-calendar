"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronUp, ChevronDown } from "lucide-react";
import { DEFAULT_DASHBOARD_CARD_ORDER, DASHBOARD_CARD_LABELS, type DashboardCardId } from "@/app/dashboard/cards";
import { updateDashboardCardIds } from "./actions";

type Row = { id: DashboardCardId; enabled: boolean };

function initialRows(initialCardIds: DashboardCardId[]): Row[] {
  const enabled = initialCardIds.map((id) => ({ id, enabled: true }));
  const rest = DEFAULT_DASHBOARD_CARD_ORDER.filter((id) => !initialCardIds.includes(id)).map((id) => ({
    id,
    enabled: false,
  }));
  return [...enabled, ...rest];
}

export function DashboardCardsForm({
  isPremium,
  initialCardIds,
}: {
  isPremium: boolean;
  initialCardIds: DashboardCardId[];
}) {
  const [rows, setRows] = useState<Row[]>(() => initialRows(initialCardIds));
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  function persist(next: Row[]) {
    setRows(next);
    setSaved(false);
    startTransition(async () => {
      const enabledIds = next.filter((r) => r.enabled).map((r) => r.id);
      await updateDashboardCardIds(enabledIds);
      setSaved(true);
    });
  }

  function toggle(index: number) {
    const next = rows.map((r, i) => (i === index ? { ...r, enabled: !r.enabled } : r));
    persist(next);
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    persist(next);
  }

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-lg font-semibold">Dashboard cards</h2>
        {!isPremium && (
          <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">
            Premium
          </span>
        )}
      </div>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
        Choose which cards appear on your dashboard, and in what order.
        {!isPremium && (
          <>
            {" "}
            <Link href="/premium" className="text-blue-600 hover:underline dark:text-blue-400">
              Upgrade to Premium
            </Link>{" "}
            to customize this.
          </>
        )}
      </p>
      <ul className="flex max-w-sm flex-col gap-1">
        {rows.map((row, index) => (
          <li
            key={row.id}
            className="flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-700"
          >
            <input
              type="checkbox"
              checked={row.enabled}
              disabled={!isPremium || isPending}
              onChange={() => toggle(index)}
            />
            <span className="flex-1">{DASHBOARD_CARD_LABELS[row.id]}</span>
            <button
              type="button"
              aria-label={`Move ${DASHBOARD_CARD_LABELS[row.id]} up`}
              disabled={!isPremium || isPending || index === 0}
              onClick={() => move(index, -1)}
              className="text-gray-400 hover:text-gray-700 disabled:opacity-30 dark:hover:text-gray-200"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label={`Move ${DASHBOARD_CARD_LABELS[row.id]} down`}
              disabled={!isPremium || isPending || index === rows.length - 1}
              onClick={() => move(index, 1)}
              className="text-gray-400 hover:text-gray-700 disabled:opacity-30 dark:hover:text-gray-200"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
      {saved && !isPending && <p className="mt-2 text-sm text-green-600 dark:text-green-400">Saved.</p>}
    </section>
  );
}
