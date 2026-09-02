"use client";

import { useState } from "react";
import * as Checkbox from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import type { ReleaseEventType, ReleaseStatus } from "@/app/generated/prisma/client";

export type InstallOption = { id: string; name: string };

const TYPE_OPTIONS: { value: ReleaseEventType; label: string }[] = [
  { value: "SHELF", label: "Shelf release" },
  { value: "PRERELEASE", label: "Prerelease" },
  { value: "PROMO", label: "Promo" },
  { value: "SPECIAL", label: "Special event" },
];

const STATUS_OPTIONS: { value: ReleaseStatus; label: string }[] = [
  { value: "RUMORED", label: "Rumored" },
  { value: "ANNOUNCED", label: "Announced" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "RELEASED", label: "Released" },
  { value: "CANCELLED", label: "Cancelled" },
];

type Props = {
  installOptions: InstallOption[];
  installIds: string[];
  types: ReleaseEventType[];
  statuses: ReleaseStatus[];
  search: string;
  onChange: (patch: {
    installIds?: string[];
    types?: ReleaseEventType[];
    statuses?: ReleaseStatus[];
    search?: string;
  }) => void;
};

function withToggled<T>(list: T[], value: T, checked: boolean): T[] {
  return checked ? [...list, value] : list.filter((v) => v !== value);
}

const checkboxBoxClass =
  "flex h-4 w-4 shrink-0 items-center justify-center rounded border border-gray-300 transition-colors data-[state=checked]:border-gray-900 data-[state=checked]:bg-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:border-gray-600 dark:data-[state=checked]:border-gray-100 dark:data-[state=checked]:bg-gray-100 dark:focus-visible:ring-gray-100";

export function FilterBar({ installOptions, installIds, types, statuses, search, onChange }: Props) {
  const [searchDraft, setSearchDraft] = useState(search);

  return (
    <div className="flex flex-col gap-6" role="search" aria-label="Filter releases">
      <div className="flex flex-col gap-1">
        <label htmlFor="filter-search" className="text-xs font-medium text-gray-600 dark:text-gray-400">
          Search
        </label>
        <input
          id="filter-search"
          type="text"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          onBlur={() => onChange({ search: searchDraft })}
          onKeyDown={(e) => {
            if (e.key === "Enter") onChange({ search: searchDraft });
          }}
          placeholder="Product set name…"
          className="rounded-md border border-gray-300 px-2 py-1 text-sm transition-colors focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100 dark:focus:border-gray-100 dark:focus:ring-gray-100"
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-medium text-gray-600 dark:text-gray-400">TCG</legend>
        <div className="flex flex-col gap-2">
          {installOptions.map((option) => (
            <label key={option.id} className="flex cursor-pointer items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
              <Checkbox.Root
                checked={installIds.includes(option.id)}
                onCheckedChange={(checked) =>
                  onChange({ installIds: withToggled(installIds, option.id, checked === true) })
                }
                className={checkboxBoxClass}
              >
                <Checkbox.Indicator>
                  <Check className="h-3 w-3 text-white dark:text-gray-900" />
                </Checkbox.Indicator>
              </Checkbox.Root>
              {option.name}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-medium text-gray-600 dark:text-gray-400">Type</legend>
        <div className="flex flex-col gap-2">
          {TYPE_OPTIONS.map((option) => (
            <label key={option.value} className="flex cursor-pointer items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
              <Checkbox.Root
                checked={types.includes(option.value)}
                onCheckedChange={(checked) =>
                  onChange({ types: withToggled(types, option.value, checked === true) })
                }
                className={checkboxBoxClass}
              >
                <Checkbox.Indicator>
                  <Check className="h-3 w-3 text-white dark:text-gray-900" />
                </Checkbox.Indicator>
              </Checkbox.Root>
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-medium text-gray-600 dark:text-gray-400">Status</legend>
        <div className="flex flex-col gap-2">
          {STATUS_OPTIONS.map((option) => (
            <label key={option.value} className="flex cursor-pointer items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
              <Checkbox.Root
                checked={statuses.includes(option.value)}
                onCheckedChange={(checked) =>
                  onChange({ statuses: withToggled(statuses, option.value, checked === true) })
                }
                className={checkboxBoxClass}
              >
                <Checkbox.Indicator>
                  <Check className="h-3 w-3 text-white dark:text-gray-900" />
                </Checkbox.Indicator>
              </Checkbox.Root>
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
