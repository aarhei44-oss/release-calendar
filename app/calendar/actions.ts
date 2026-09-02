"use server";

import { z } from "zod";
import {
  getFilteredEvents as repoGetFilteredEvents,
  getEventDetail as repoGetEventDetail,
} from "@/data/calendar/calendarRepo";

const releaseEventType = z.enum(["SHELF", "PRERELEASE", "PROMO", "SPECIAL"]);
const releaseStatus = z.enum(["RUMORED", "ANNOUNCED", "CONFIRMED", "RELEASED", "CANCELLED"]);

const filtersSchema = z.object({
  installIds: z.array(z.string()).optional(),
  types: z.array(releaseEventType).optional(),
  statuses: z.array(releaseStatus).optional(),
  search: z.string().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export async function getFilteredEvents(input: z.infer<typeof filtersSchema>) {
  const filters = filtersSchema.parse(input);
  return repoGetFilteredEvents(filters);
}

const eventIdSchema = z.string().min(1);

export async function getEventDetail(eventId: string) {
  const parsed = eventIdSchema.parse(eventId);
  return repoGetEventDetail(parsed);
}
