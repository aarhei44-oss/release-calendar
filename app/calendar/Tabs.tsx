"use client";

import type { KeyboardEvent } from "react";
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

export function tabPanelId(tab: CalendarTab): string {
  return `calendar-tabpanel-${tab}`;
}

export function Tabs({ active, onChange }: Props) {
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = TABS.findIndex((t) => t.value === active);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const delta = e.key === "ArrowRight" ? 1 : -1;
      const nextIndex = (currentIndex + delta + TABS.length) % TABS.length;
      onChange(TABS[nextIndex].value);
    } else if (e.key === "Home") {
      e.preventDefault();
      onChange(TABS[0].value);
    } else if (e.key === "End") {
      e.preventDefault();
      onChange(TABS[TABS.length - 1].value);
    }
  }

  return (
    <div
      role="tablist"
      aria-label="Calendar views"
      className="flex gap-1 border-b border-gray-200"
      onKeyDown={handleKeyDown}
    >
      {TABS.map((tab) => {
        const isActive = tab.value === active;
        return (
          <button
            key={tab.value}
            id={`calendar-tab-${tab.value}`}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={tabPanelId(tab.value)}
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
