"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { triggerRescan, triggerDedup } from "./actions";

type ScanRun = {
  id: string;
  scopeType: string;
  scopeId: string | null;
  status: string;
  trigger: string;
  createdAt: Date;
  finishedAt: Date | null;
};

type InstallOption = { id: string; label: string };

const STATUS_STYLES: Record<string, string> = {
  RUNNING: "bg-blue-100 text-blue-700",
  SUCCEEDED: "bg-green-100 text-green-700",
  FAILED: "bg-red-100 text-red-700",
};

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function SystemTab({ installs, scanRuns }: { installs: InstallOption[]; scanRuns: ScanRun[] }) {
  const router = useRouter();
  const [selectedInstall, setSelectedInstall] = useState(installs[0]?.id ?? "");
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function runRescan() {
    if (!selectedInstall) return;
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await triggerRescan(selectedInstall);
        setMessage(
          result.skipped
            ? `Rescan skipped: ${result.reason}`
            : `Rescan complete: ${result.totals.sourcesFetched} source(s) fetched, ${result.totals.claimsCreated} claim(s) recorded (${result.totals.eventsCreated} new event(s), ${result.totals.eventsUpdated} updated, ${result.totals.errors} error(s)).`,
        );
        router.refresh();
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "Rescan failed.");
      }
    });
  }

  function runDedup() {
    setMessage(null);
    startTransition(async () => {
      try {
        const result = await triggerDedup();
        setMessage(`Dedup complete: checked ${result.groupsChecked} group(s), merged ${result.eventsMerged} duplicate event(s).`);
        router.refresh();
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "Dedup pass failed.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={selectedInstall}
          onChange={(e) => setSelectedInstall(e.target.value)}
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        >
          {installs.map((install) => (
            <option key={install.id} value={install.id}>
              {install.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={isPending || !selectedInstall}
          onClick={runRescan}
          className="rounded-md border border-gray-300 px-3 py-1 text-sm hover:bg-gray-100 disabled:opacity-50"
        >
          Trigger manual rescan
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={runDedup}
          className="rounded-md border border-gray-300 px-3 py-1 text-sm hover:bg-gray-100 disabled:opacity-50"
        >
          Trigger dedup pass
        </button>
      </div>

      {message && <p className="text-sm text-gray-600">{message}</p>}

      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
            <th className="py-2">Status</th>
            <th>Scope</th>
            <th>Trigger</th>
            <th>Started</th>
            <th>Finished</th>
          </tr>
        </thead>
        <tbody>
          {scanRuns.map((run) => (
            <tr key={run.id} className="border-b border-gray-100">
              <td className="py-2">
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[run.status] ?? "bg-gray-100 text-gray-700"}`}>
                  {run.status}
                </span>
              </td>
              <td>{run.scopeType}</td>
              <td>{run.trigger}</td>
              <td>{DATE_FORMATTER.format(run.createdAt)}</td>
              <td>{run.finishedAt ? DATE_FORMATTER.format(run.finishedAt) : "—"}</td>
            </tr>
          ))}
          {scanRuns.length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-center text-gray-500">
                No scan runs yet — trigger a manual rescan above, or wait for the next scheduled scan.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
