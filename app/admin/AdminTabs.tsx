"use client";

import { useState, type KeyboardEvent } from "react";
import { ProfilesTab } from "./ProfilesTab";
import { UsersTab } from "./UsersTab";
import { SystemTab } from "./SystemTab";
import { ReviewTab } from "./ReviewTab";
import type {
  listPackagesWithInstalls,
  listUsers,
  listScanRuns,
  listContradictedEvents,
} from "./actions";

type AdminTab = "profiles" | "users" | "system" | "review";

const TABS: { value: AdminTab; label: string }[] = [
  { value: "profiles", label: "Profiles" },
  { value: "users", label: "Users" },
  { value: "system", label: "System" },
  { value: "review", label: "Review" },
];

type Props = {
  packages: Awaited<ReturnType<typeof listPackagesWithInstalls>>;
  users: Awaited<ReturnType<typeof listUsers>>;
  scanRuns: Awaited<ReturnType<typeof listScanRuns>>;
  contradictedEvents: Awaited<ReturnType<typeof listContradictedEvents>>;
};

export function AdminTabs({ packages, users, scanRuns, contradictedEvents }: Props) {
  const [active, setActive] = useState<AdminTab>("profiles");

  const installOptions = packages.flatMap((pkg) =>
    pkg.installs.map((install) => ({
      id: install.id,
      label: `${pkg.name} (${install.installedVersion})`,
    })),
  );

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = TABS.findIndex((t) => t.value === active);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? 1 : -1;
      setActive(TABS[(currentIndex + delta + TABS.length) % TABS.length].value);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(TABS[0].value);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(TABS[TABS.length - 1].value);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div
        role="tablist"
        aria-label="Admin sections"
        className="flex gap-1 border-b border-gray-200"
        onKeyDown={handleKeyDown}
      >
        {TABS.map((tab) => {
          const isActive = tab.value === active;
          return (
            <button
              key={tab.value}
              id={`admin-tab-${tab.value}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`admin-tabpanel-${tab.value}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActive(tab.value)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                isActive
                  ? "border-gray-900 text-gray-900"
                  : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              {tab.label}
              {tab.value === "review" && contradictedEvents.length > 0 && (
                <span className="ml-1.5 rounded-full bg-red-100 px-1.5 py-0.5 text-xs font-semibold text-red-800">
                  {contradictedEvents.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {active === "profiles" && (
        <div
          id="admin-tabpanel-profiles"
          role="tabpanel"
          aria-labelledby="admin-tab-profiles"
          tabIndex={0}
        >
          <ProfilesTab packages={packages} />
        </div>
      )}
      {active === "users" && (
        <div
          id="admin-tabpanel-users"
          role="tabpanel"
          aria-labelledby="admin-tab-users"
          tabIndex={0}
        >
          <UsersTab users={users} />
        </div>
      )}
      {active === "system" && (
        <div
          id="admin-tabpanel-system"
          role="tabpanel"
          aria-labelledby="admin-tab-system"
          tabIndex={0}
        >
          <SystemTab installs={installOptions} scanRuns={scanRuns} />
        </div>
      )}
      {active === "review" && (
        <div
          id="admin-tabpanel-review"
          role="tabpanel"
          aria-labelledby="admin-tab-review"
          tabIndex={0}
        >
          <ReviewTab events={contradictedEvents} />
        </div>
      )}
    </div>
  );
}
