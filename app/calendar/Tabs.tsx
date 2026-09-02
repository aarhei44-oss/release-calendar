"use client";

import type { CalendarTab } from "./searchParams";

const TABS: { value: CalendarTab; label: string }[] = [
  { value: "calendar", label: "Calendar" },
  { value: "list", label: "Events List" },
  { value: "upcoming", label: "Upcoming" },
];

type Props = {
  active: CalendarTab;
  onChange: (tab: CalendarTab) => void;
};

export function Tabs({ active, onChange }: Props) {
  return (
    <div role="tablist" aria-label="Calendar views" className="flex gap-1 border-b border-gray-200">
      {TABS.map((tab) => {
        const isActive = tab.value === active;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              isActive
                ? "border-gray-900 text-gray-900"
                : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
