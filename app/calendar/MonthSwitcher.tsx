"use client";

import { addMonths } from "./searchParams";

type Props = {
  month: string; // YYYY-MM
  onChange: (month: string) => void;
};

const MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

export function MonthSwitcher({ month, onChange }: Props) {
  const [year, mon] = month.split("-").map(Number);
  const label = MONTH_LABEL_FORMATTER.format(new Date(year, mon - 1, 1));

  return (
    <div className="flex items-center gap-3" role="group" aria-label="Month navigation">
      <button
        type="button"
        onClick={() => onChange(addMonths(month, -1))}
        aria-label="Previous month"
        className="rounded-md border border-gray-300 px-2 py-1 text-sm hover:bg-gray-100"
      >
        ‹
      </button>
      <span className="min-w-[10rem] text-center font-medium" aria-live="polite">
        {label}
      </span>
      <button
        type="button"
        onClick={() => onChange(addMonths(month, 1))}
        aria-label="Next month"
        className="rounded-md border border-gray-300 px-2 py-1 text-sm hover:bg-gray-100"
      >
        ›
      </button>
    </div>
  );
}
