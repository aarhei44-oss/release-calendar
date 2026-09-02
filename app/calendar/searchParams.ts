import type { ReleaseEventType, ReleaseStatus } from "@/app/generated/prisma/client";

export type CalendarTab = "calendar" | "list" | "upcoming";

export type ParsedCalendarSearchParams = {
  tab: CalendarTab;
  calMonth: string; // YYYY-MM, used by the "calendar" tab
  listMonth: string; // YYYY-MM, used by the "list" tab
  installIds: string[];
  types: ReleaseEventType[];
  statuses: ReleaseStatus[];
  search: string;
  eventId: string | null;
};

const RELEASE_EVENT_TYPES: ReleaseEventType[] = ["SHELF", "PRERELEASE", "PROMO", "SPECIAL"];
const RELEASE_STATUSES: ReleaseStatus[] = ["RUMORED", "ANNOUNCED", "CONFIRMED", "RELEASED", "CANCELLED"];

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function parseMonth(value: string | undefined): string {
  if (value && /^\d{4}-\d{2}$/.test(value)) return value;
  return currentMonth();
}

function parseCsv<T extends string>(value: string | undefined, allowed: T[]): T[] {
  if (!value) return [];
  const set = new Set(allowed);
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v): v is T => set.has(v as T));
}

export type RawSearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseCalendarSearchParams(raw: RawSearchParams): ParsedCalendarSearchParams {
  const tabRaw = first(raw.tab);
  const tab: CalendarTab = tabRaw === "list" || tabRaw === "upcoming" ? tabRaw : "calendar";

  return {
    tab,
    calMonth: parseMonth(first(raw.calMonth)),
    listMonth: parseMonth(first(raw.listMonth)),
    installIds: parseCsv(first(raw.installIds), []),
    types: parseCsv(first(raw.types), RELEASE_EVENT_TYPES),
    statuses: parseCsv(first(raw.statuses), RELEASE_STATUSES),
    search: first(raw.search)?.trim() ?? "",
    eventId: first(raw.eventId) ?? null,
  };
}

/** Builds a query string, merging `overrides` onto the currently parsed params. */
export function buildCalendarHref(
  params: ParsedCalendarSearchParams,
  overrides: Partial<Record<keyof ParsedCalendarSearchParams, string | string[] | null>>,
): string {
  const next = new URLSearchParams();
  const merged: Record<string, string> = {
    tab: params.tab,
    calMonth: params.calMonth,
    listMonth: params.listMonth,
    installIds: params.installIds.join(","),
    types: params.types.join(","),
    statuses: params.statuses.join(","),
    search: params.search,
    eventId: params.eventId ?? "",
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = Array.isArray(value) ? value.join(",") : value;
    }
  }

  for (const [key, value] of Object.entries(merged)) {
    if (value) next.set(key, value);
  }

  const qs = next.toString();
  return qs ? `/calendar?${qs}` : "/calendar";
}

export function addMonths(month: string, delta: number): string {
  const [year, mon] = month.split("-").map(Number);
  const date = new Date(year, mon - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function monthRange(month: string): { from: Date; to: Date } {
  const [year, mon] = month.split("-").map(Number);
  const from = new Date(year, mon - 1, 1);
  const to = new Date(year, mon, 0, 23, 59, 59, 999);
  return { from, to };
}
