"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toggleInstallEnabled, enableAndSeedInstall } from "./actions";

type Install = {
  id: string;
  installedVersion: string;
  enabled: boolean;
  _count: { productSets: number };
};

type Package = {
  id: string;
  name: string;
  slug: string;
  version: string;
  installs: Install[];
};

export function ProfilesTab({ packages }: { packages: Package[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle(installId: string, enabled: boolean) {
    setError(null);
    startTransition(async () => {
      try {
        await toggleInstallEnabled(installId, enabled);
        router.refresh();
      } catch {
        setError("Couldn't update that install.");
      }
    });
  }

  function enableAndSeed(installId: string) {
    setError(null);
    startTransition(async () => {
      try {
        await enableAndSeedInstall(installId);
        router.refresh();
      } catch {
        setError("Couldn't enable & seed that install.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {packages.map((pkg) => (
        <section key={pkg.id}>
          <h3 className="font-medium">
            {pkg.name} <span className="text-xs text-gray-500">v{pkg.version}</span>
          </h3>
          <ul className="mt-2 flex flex-col gap-2">
            {pkg.installs.map((install) => (
              <li
                key={install.id}
                className="flex items-center justify-between rounded-md border border-gray-200 p-2 text-sm"
              >
                <div>
                  <span className="font-medium">install {install.installedVersion}</span>{" "}
                  <span className="text-gray-500">· {install._count.productSets} product sets</span>
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={install.enabled}
                      disabled={isPending}
                      onChange={(e) => toggle(install.id, e.target.checked)}
                    />
                    Enabled
                  </label>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => enableAndSeed(install.id)}
                    className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-50"
                  >
                    Enable &amp; Seed
                  </button>
                </div>
              </li>
            ))}
            {pkg.installs.length === 0 && (
              <li className="text-sm text-gray-500">No installs for this package.</li>
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}
