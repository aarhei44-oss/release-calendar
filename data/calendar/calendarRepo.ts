import { prisma } from "@/lib/prisma";
import type { Prisma, ReleaseEventType, ReleaseStatus } from "@/app/generated/prisma/client";

export type CalendarFilters = {
  installIds?: string[];
  types?: ReleaseEventType[];
  statuses?: ReleaseStatus[];
  search?: string;
  from?: Date;
  to?: Date;
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
  const where: Prisma.ReleaseEventWhereInput = {};
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

    dateConditions.push({ dateType: "TBD" });

    where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { OR: dateConditions }];
  }

  return where;
}

export async function getFilteredEvents(filters: CalendarFilters = {}): Promise<CalendarEvent[]> {
  return prisma.releaseEvent.findMany({
    where: buildWhere(filters),
    orderBy: [{ dateExact: "asc" }, { dateStart: "asc" }, { windowStart: "asc" }],
    ...eventWithRelations,
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
