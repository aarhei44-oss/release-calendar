import type { DateType, SourceDisposition, WindowGranularity } from "@/app/generated/prisma/client";

export type EventDateInfo = {
  dateType: DateType;
  dateExact?: Date | null;
  dateStart?: Date | null;
  dateEnd?: Date | null;
  windowGranularity?: WindowGranularity | null;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  isManualOverride?: boolean;
};

const PROXIMITY_DAYS = 14;
const MIN_NORMALIZED_NAME_LENGTH = 3;

/**
 * Normalizes a ProductSet name for cross-source identity matching: lowercase,
 * strip parenthetical annotations (e.g. a trailing set-code like "(EB-05)"),
 * strip all non-alphanumeric characters. Deliberately more aggressive/lossy
 * than the crawler adapters' own `slugify()` (which preserves structure for
 * a stable id) -- this only ever answers "do these two scraped names mean
 * the same real product," never used as an id itself.
 *
 * Returns "" for names that are entirely punctuation/parenthetical content
 * (e.g. "(2026)") -- callers must treat an empty (or otherwise too-short)
 * result as "not matchable," never as a valid grouping key, or every such
 * ProductSet in an install would collide with each other.
 */
export function normalizeProductSetName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function isMatchableNormalizedName(normalized: string): boolean {
  return normalized.length >= MIN_NORMALIZED_NAME_LENGTH;
}

function primaryDate(info: EventDateInfo): Date | null {
  return info.dateExact ?? info.dateStart ?? info.windowStart ?? null;
}

/**
 * Business rule 6.4: within an install, release events are deduped by
 * product set + event type + date proximity. Callers pre-filter `existing`
 * to the candidate's (productSetId, type) before calling this.
 */
export function findMatchingEvent<T extends EventDateInfo>(candidate: EventDateInfo, existing: T[]): T | null {
  // A manually-overridden event always wins the match for its
  // (productSet, type), regardless of date proximity -- that's the whole
  // point of an override: the crawler's discovered date may legitimately
  // disagree with it, and new claims should still land on it "for
  // visibility" (technical-spec.md §6.3 step 5) rather than spawn a
  // duplicate event.
  const overridden = existing.find((e) => e.isManualOverride);
  if (overridden) return overridden;

  if (candidate.dateType === "TBD") {
    return existing.find((e) => e.dateType === "TBD") ?? null;
  }

  const candidateDate = primaryDate(candidate);
  if (!candidateDate) return null;

  let best: T | null = null;
  let bestDiffDays = Infinity;

  for (const event of existing) {
    const eventDate = primaryDate(event);
    if (!eventDate) continue;
    const diffDays = Math.abs(candidateDate.getTime() - eventDate.getTime()) / (1000 * 60 * 60 * 24);
    if (diffDays <= PROXIMITY_DAYS && diffDays < bestDiffDays) {
      best = event;
      bestDiffDays = diffDays;
    }
  }

  return best;
}

/**
 * Whether a newly discovered candidate date agrees with an event's
 * current best-known date, for tagging the resulting SourceClaim's
 * disposition. Claims are immutable (business rule 6.3) -- this only
 * decides how the new claim describes itself relative to what's already
 * on record, it never changes past claims.
 */
export function dispositionFor(
  candidate: EventDateInfo,
  currentEvent: EventDateInfo | null,
): SourceDisposition {
  if (!currentEvent || currentEvent.dateType === "TBD" || candidate.dateType === "TBD") {
    return "SUPPORTS";
  }

  const candidateDate = primaryDate(candidate);
  const currentDate = primaryDate(currentEvent);
  if (!candidateDate || !currentDate) return "SUPPORTS";

  const diffDays = Math.abs(candidateDate.getTime() - currentDate.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays <= PROXIMITY_DAYS ? "SUPPORTS" : "CONTRADICTS";
}
