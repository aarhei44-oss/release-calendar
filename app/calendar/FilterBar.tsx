"use client";

import { useState } from "react";
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

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function FilterBar({ installOptions, installIds, types, statuses, search, onChange }: Props) {
  const [searchDraft, setSearchDraft] = useState(search);

  return (
    <div className="flex flex-wrap items-end gap-4 border-b border-gray-200 pb-4" role="search" aria-label="Filter releases">
      <div className="flex flex-col gap-1">
        <label htmlFor="filter-search" className="text-xs font-medium text-gray-600">
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
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
        />
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-gray-600">TCG</legend>
        <div className="flex flex-wrap gap-2">
          {installOptions.map((option) => (
            <label key={option.id} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={installIds.includes(option.id)}
                onChange={() => onChange({ installIds: toggle(installIds, option.id) })}
              />
              {option.name}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-gray-600">Type</legend>
        <div className="flex flex-wrap gap-2">
          {TYPE_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={types.includes(option.value)}
                onChange={() => onChange({ types: toggle(types, option.value) })}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-gray-600">Status</legend>
        <div className="flex flex-wrap gap-2">
          {STATUS_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={statuses.includes(option.value)}
                onChange={() => onChange({ statuses: toggle(statuses, option.value) })}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
