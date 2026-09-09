import { prisma } from "@/lib/prisma";
import type { DateType, Prisma, ReleaseEventType, ReleaseStatus } from "@/app/generated/prisma/client";

export type CalendarFilters = {
  installIds?: string[];
  types?: ReleaseEventType[];
  statuses?: ReleaseStatus[];
  search?: string;
  from?: Date;
  to?: Date;
  /** Restricts to events whose date is recorded a particular way -- the Unconfirmed tab passes ["TBD"] (with no from/to) to ask for exactly the undated pile. */
  dateTypes?: DateType[];
};

const eventWithRelations = {
  include: {
    productSet: {
      include: {
        install: {
          include: { package: true },
        },
      },
    },
  },
} satisfies Prisma.ReleaseEventDefaultArgs;

export type CalendarEvent = Prisma.ReleaseEventGetPayload<typeof eventWithRelations>;

function buildWhere(filters: CalendarFilters): Prisma.ReleaseEventWhereInput {
  const where: Prisma.ReleaseEventWhereInput = { archivedAt: null };
  const productSetWhere: Prisma.ProductSetWhereInput = {};

  if (filters.installIds?.length) {
    productSetWhere.tcgProfileInstallId = { in: filters.installIds };
  }

  if (filters.types?.length) {
    where.type = { in: filters.types };
  }

  if (filters.statuses?.length) {
    where.status = { in: filters.statuses };
  }

  if (filters.dateTypes?.length) {
    where.dateType = { in: filters.dateTypes };
  }

  if (filters.search) {
    productSetWhere.OR = [
      { name: { contains: filters.search } },
      { code: { contains: filters.search } },
    ];
  }

  if (Object.keys(productSetWhere).length > 0) {
    where.productSet = { is: productSetWhere };
  }

  if (filters.from || filters.to) {
    const dateConditions: Prisma.ReleaseEventWhereInput[] = [];

    const exact: Prisma.DateTimeNullableFilter = {};
    if (filters.from) exact.gte = filters.from;
    if (filters.to) exact.lte = filters.to;
    dateConditions.push({ dateType: "EXACT", dateExact: exact });

    const rangeOverlap: Prisma.ReleaseEventWhereInput = { dateType: "RANGE" };
    if (filters.to) rangeOverlap.dateStart = { lte: filters.to };
    if (filters.from) rangeOverlap.dateEnd = { gte: filters.from };
    dateConditions.push(rangeOverlap);

    const windowOverlap: Prisma.ReleaseEventWhereInput = { dateType: "WINDOW" };
    if (filters.to) windowOverlap.windowStart = { lte: filters.to };
    if (filters.from) windowOverlap.windowEnd = { gte: filters.from };
    dateConditions.push(windowOverlap);

    // TBD events are deliberately absent from every one of these conditions:
    // an undated event has no date to range-check, so it can only ever match
    // a window arbitrarily. It used to be admitted to any range spanning
    // "now", which meant a years-old never-dated crawl artifact (e.g. a
    // discontinued 1997 MTG product) piled into whichever month happened to
    // contain today, as if it were releasing then. They're reachable on their
    // own terms instead, via dateTypes: ["TBD"] with no from/to -- what the
    // calendar's Unconfirmed tab queries.
    where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { OR: dateConditions }];
  }

  return where;
}

/**
 * Hides a dateless prerelease when a dated one already covers the same product
 * and region.
 *
 * A set can end up with two PRERELEASE rows, and legitimately so. One comes
 * from a source -- Wikipedia's "Pre-release date" column is the only origin
 * that states Magic's -- and stays undated when gate rule G8 declines to
 * endorse it, which happens when the stated date is nowhere near the one the
 * game's schedule implies (a mis-parsed cell, usually). The other is written by
 * the derivation pass, which fills exactly the slot that refusal left open
 * (lib/ingest/derivePrereleases.ts). Both rows are correct: the first records
 * that we hold an unplaceable claim, the second carries the scheduled date.
 *
 * To a reader they are one prerelease listed twice, in two different tabs. So
 * the dateless one is dropped here, at the point of display, rather than in
 * ingest -- suppressing it there would mean the derivation pass reaching into a
 * row the gate owns, and the whole reason those two populations are disjoint is
 * that neither writes the other's rows.
 *
 * Scoped to (productSet, region) because that is what makes two prerelease rows
 * the same event: a dated JP prerelease says nothing about an undated global
 * one, and hiding the second on the strength of the first would lose a real
 * fact. And scoped to PRERELEASE, because it is the only type this pipeline
 * ever writes a parallel derived row for.
 *
 * Note this deliberately ignores the caller's own filters: a dateless
 * prerelease stays hidden even when the dated row that supersedes it is
 * filtered out of the same result (different status, say). Suppression that
 * depended on filter state would make a duplicate wink into existence when
 * somebody toggled a status chip, which is a stranger thing to explain than a
 * row that is consistently absent.
 */
async function dropSupersededDatelessPrereleases(events: CalendarEvent[]): Promise<CalendarEvent[]> {
  const dateless = events.filter((event) => event.type === "PRERELEASE" && event.dateType === "TBD");
  if (dateless.length === 0) return events;

  const dated = await prisma.releaseEvent.findMany({
    where: {
      type: "PRERELEASE",
      archivedAt: null,
      dateType: { not: "TBD" },
      productSetId: { in: [...new Set(dateless.map((event) => event.productSetId))] },
    },
    select: { productSetId: true, region: true },
  });
  if (dated.length === 0) return events;

  // NUL-separated for the same reason the ingest pipeline's keys are: no
  // component can forge a collision by containing the separator.
  const covered = new Set(dated.map((row) => `${row.productSetId}\0${row.region}`));
  return events.filter(
    (event) =>
      !(
        event.type === "PRERELEASE" &&
        event.dateType === "TBD" &&
        covered.has(`${event.productSetId}\0${event.region}`)
      ),
  );
}

export async function getFilteredEvents(filters: CalendarFilters = {}): Promise<CalendarEvent[]> {
  const events = await prisma.releaseEvent.findMany({
    where: buildWhere(filters),
    // Name last as a tiebreaker: every TBD event has all three date columns
    // null, so the Unconfirmed tab's result would otherwise come back in
    // whatever order the database felt like -- and shuffle between requests.
    orderBy: [{ dateExact: "asc" }, { dateStart: "asc" }, { windowStart: "asc" }, { productSet: { name: "asc" } }],
    ...eventWithRelations,
  });
  return dropSupersededDatelessPrereleases(events);
}

/**
 * Events updated since a cutoff, most-recently-updated first -- the closest
 * approximation of "recent status changes" this schema supports. There's no
 * status-history table, so this can only say an event was touched and what
 * it is *now*, not what it changed from (a brand-new discovery and a
 * RUMORED->CONFIRMED jump look the same here: both just bump updatedAt).
 * Capped at 20 so a very active subscription set doesn't return unbounded
 * rows for a dashboard "what's new" feed.
 *
 * The superseded-prerelease filter runs *after* that cap, so a feed carrying
 * one comes back with 19. That is deliberate rather than tolerated: the
 * dashboard renders this list's length as a stat tile
 * (app/dashboard/DashboardShell.tsx) directly above the card listing these
 * same events, so the number has to agree with the rows underneath it or it
 * reads as a bug. excludeDismissed (data/subscriptions/subscriptionsRepo.ts)
 * already post-filters here for the same reason. Topping the page back up to
 * 20 would cost a second query and put the tile back out of step with its own
 * list -- and the cap already means the number is "how many are shown", never
 * "how many exist".
 */
export async function getRecentlyUpdatedEvents(filters: { installIds?: string[]; updatedSince: Date }): Promise<CalendarEvent[]> {
  const events = await prisma.releaseEvent.findMany({
    where: {
      archivedAt: null,
      updatedAt: { gte: filters.updatedSince },
      ...(filters.installIds?.length ? { productSet: { tcgProfileInstallId: { in: filters.installIds } } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: 20,
    ...eventWithRelations,
  });
  return dropSupersededDatelessPrereleases(events);
}

/**
 * Events whose *start* date (dateExact for EXACT, dateStart for RANGE,
 * windowStart for WINDOW) falls on the given calendar day -- for lead-time
 * reminders ("notify me N days before release"), which should fire once,
 * the day an event is exactly N days out, not on every day of a multi-day
 * RANGE/WINDOW's span the way a plain overlap query (like getFilteredEvents'
 * from/to) would.
 */
export async function getEventsStartingOn(filters: { installIds?: string[]; day: Date }): Promise<CalendarEvent[]> {
  const dayStart = new Date(filters.day.getFullYear(), filters.day.getMonth(), filters.day.getDate());
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);

  return prisma.releaseEvent.findMany({
    where: {
      archivedAt: null,
      ...(filters.installIds?.length ? { productSet: { tcgProfileInstallId: { in: filters.installIds } } } : {}),
      OR: [
        { dateType: "EXACT", dateExact: { gte: dayStart, lte: dayEnd } },
        { dateType: "RANGE", dateStart: { gte: dayStart, lte: dayEnd } },
        { dateType: "WINDOW", windowStart: { gte: dayStart, lte: dayEnd } },
      ],
    },
    orderBy: [{ dateExact: "asc" }, { dateStart: "asc" }, { windowStart: "asc" }],
    ...eventWithRelations,
  });
}

export async function createComment(params: { userId: string; releaseEventId: string; content: string }) {
  return prisma.userNote.create({
    data: params,
    include: { user: { select: { id: true, name: true, image: true } } },
  });
}

export async function getCommentById(commentId: string) {
  return prisma.userNote.findUnique({ where: { id: commentId } });
}

export async function deleteCommentById(commentId: string) {
  await prisma.userNote.delete({ where: { id: commentId } });
}

/** Live counts for the landing page's trust-building stat line ("X upcoming releases across Y games"). */
export async function getLandingStats() {
  const [releasesTracked, gamesTracked] = await Promise.all([
    prisma.releaseEvent.count({ where: { archivedAt: null, status: { notIn: ["RELEASED", "CANCELLED"] } } }),
    prisma.tcgProfileInstall.count({ where: { enabled: true } }),
  ]);
  return { releasesTracked, gamesTracked };
}

/** Enabled installs, for populating the public filter bar's install dropdown. */
export async function listEnabledInstallsForFilters() {
  return prisma.tcgProfileInstall.findMany({
    where: { enabled: true },
    select: { id: true, package: { select: { name: true, slug: true } } },
    orderBy: { package: { name: "asc" } },
  });
}

export async function getEventDetail(eventId: string) {
  return prisma.releaseEvent.findUnique({
    where: { id: eventId },
    include: {
      productSet: {
        include: {
          install: { include: { package: true } },
        },
      },
      sourceClaims: {
        orderBy: { lastVerifiedAt: "desc" },
      },
      userNotes: {
        orderBy: { createdAt: "desc" },
        include: { user: { select: { id: true, name: true, image: true } } },
      },
    },
  });
}
