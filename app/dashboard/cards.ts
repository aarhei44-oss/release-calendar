export type DashboardCardId = "upcoming" | "newlyConfirmed" | "recentActivity";

export const DASHBOARD_CARD_LABELS: Record<DashboardCardId, string> = {
  upcoming: "Next 7 days",
  newlyConfirmed: "Newly confirmed",
  recentActivity: "What's new",
};

/** Every card, in the default order -- what a non-premium (or not-yet-customized) dashboard shows. */
export const DEFAULT_DASHBOARD_CARD_ORDER: DashboardCardId[] = ["upcoming", "newlyConfirmed", "recentActivity"];

export function isDashboardCardId(value: string): value is DashboardCardId {
  return (DEFAULT_DASHBOARD_CARD_ORDER as string[]).includes(value);
}

/**
 * Resolves a user's stored card order (a possibly-partial, possibly-
 * reordered subset from Json, or null/malformed) into a valid ordered list
 * -- de-duplicated, filtered to known ids only, no premium check here (that
 * happens where this is called, e.g. dashboard/page.tsx only reads a
 * premium user's stored value in the first place). Only null/malformed
 * (never customized) falls back to the default order -- a deliberately
 * empty array (every card unchecked) stays empty rather than silently
 * reverting to "show everything", which would ignore what the user asked
 * for.
 */
export function resolveDashboardCardOrder(stored: unknown): DashboardCardId[] {
  if (!Array.isArray(stored)) return DEFAULT_DASHBOARD_CARD_ORDER;
  const seen = new Set<DashboardCardId>();
  for (const entry of stored) {
    if (typeof entry === "string" && isDashboardCardId(entry)) seen.add(entry);
  }
  return [...seen];
}
