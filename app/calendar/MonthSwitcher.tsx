"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { addMonths } from "./searchParams";

type Props = {
  month: string; // YYYY-MM
  onChange: (month: string) => void;
};

const MONTH_LABEL_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

export function MonthSwitcher({ month, onChange }: Props) {
  const [year, mon] = month.split("-").map(Number);
  const label = MONTH_LABEL_FORMATTER.format(new Date(year, mon - 1, 1));

  const buttonClass =
    "rounded-md border border-gray-300 p-2 text-sm transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:border-gray-700 dark:hover:bg-gray-800 dark:focus-visible:ring-gray-100";

  return (
    <div className="flex items-center gap-3" role="group" aria-label="Month navigation">
      <button
        type="button"
        onClick={() => onChange(addMonths(month, -1))}
        aria-label="Previous month"
        className={buttonClass}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="min-w-40 text-center font-medium" aria-live="polite">
        {label}
      </span>
      <button
        type="button"
        onClick={() => onChange(addMonths(month, 1))}
        aria-label="Next month"
        className={buttonClass}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
