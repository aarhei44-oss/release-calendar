"use client";

import { useState } from "react";
import { ProfilesTab } from "./ProfilesTab";
import { UsersTab } from "./UsersTab";
import { SystemTab } from "./SystemTab";
import type { listPackagesWithInstalls, listUsers, listScanRuns } from "./actions";

type AdminTab = "profiles" | "users" | "system";

const TABS: { value: AdminTab; label: string }[] = [
  { value: "profiles", label: "Profiles" },
  { value: "users", label: "Users" },
  { value: "system", label: "System" },
];

type Props = {
  packages: Awaited<ReturnType<typeof listPackagesWithInstalls>>;
  users: Awaited<ReturnType<typeof listUsers>>;
  scanRuns: Awaited<ReturnType<typeof listScanRuns>>;
};

export function AdminTabs({ packages, users, scanRuns }: Props) {
  const [active, setActive] = useState<AdminTab>("profiles");

  const installOptions = packages.flatMap((pkg) =>
    pkg.installs.map((install) => ({ id: install.id, label: `${pkg.name} (${install.installedVersion})` })),
  );

  return (
    <div className="flex flex-col gap-4 p-4">
      <div role="tablist" aria-label="Admin sections" className="flex gap-1 border-b border-gray-200">
        {TABS.map((tab) => {
          const isActive = tab.value === active;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActive(tab.value)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                isActive ? "border-gray-900 text-gray-900" : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {active === "profiles" && <ProfilesTab packages={packages} />}
      {active === "users" && <UsersTab users={users} />}
      {active === "system" && <SystemTab installs={installOptions} scanRuns={scanRuns} />}
    </div>
  );
}
