export type ParsedDate =
  | { dateType: "EXACT"; dateExact: Date }
  | { dateType: "WINDOW"; windowGranularity: "MONTH"; windowStart: Date; windowEnd: Date }
  | { dateType: "TBD" };

const MONTH_DAY_YEAR = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/;
const MONTH_YEAR = /^([A-Za-z]+)\.?\s+(\d{4})$/;

const MONTH_INDEX: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Parses release-date text as it commonly appears on Wikipedia-style
 * tables and TCG tracker sites: "May 9, 2012", "Jun 12, 2026", or
 * "December 1993" (month + year only -> a one-month WINDOW). Anything
 * unrecognized becomes TBD rather than throwing, since scraped text is
 * inherently messy.
 */
export function parseFlexibleDate(raw: string): ParsedDate {
  const text = raw.trim().replace(/\s+/g, " ");

  const exact = MONTH_DAY_YEAR.exec(text);
  if (exact) {
    const month = MONTH_INDEX[exact[1].toLowerCase()];
    const day = Number(exact[2]);
    const year = Number(exact[3]);
    if (month !== undefined && isValidDate(year, month, day)) {
      return { dateType: "EXACT", dateExact: new Date(Date.UTC(year, month, day)) };
    }
  }

  const monthYear = MONTH_YEAR.exec(text);
  if (monthYear) {
    const month = MONTH_INDEX[monthYear[1].toLowerCase()];
    const year = Number(monthYear[2]);
    if (month !== undefined) {
      const windowStart = new Date(Date.UTC(year, month, 1));
      const windowEnd = new Date(Date.UTC(year, month + 1, 0));
      return { dateType: "WINDOW", windowGranularity: "MONTH", windowStart, windowEnd };
    }
  }

  return { dateType: "TBD" };
}

function isValidDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month && d.getUTCDate() === day;
}
