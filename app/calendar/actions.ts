"use server";

import { z } from "zod";
import {
  getFilteredEvents as repoGetFilteredEvents,
  getEventDetail as repoGetEventDetail,
  createComment,
  getCommentById,
  deleteCommentById,
} from "@/data/calendar/calendarRepo";
import { requireUser, ForbiddenError } from "@/lib/authGuards";
import { checkRateLimit } from "@/lib/rateLimit";

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

const addCommentSchema = z.object({
  eventId: z.string().min(1),
  content: z.string().trim().min(1).max(2000),
});

export async function addComment(input: z.infer<typeof addCommentSchema>) {
  const user = await requireUser();
  const { eventId, content } = addCommentSchema.parse(input);
  checkRateLimit(`addComment:${user.id}`, { max: 10, windowMs: 60_000 });
  return createComment({ userId: user.id, releaseEventId: eventId, content });
}

export async function deleteComment(commentId: string) {
  const user = await requireUser();
  const parsed = eventIdSchema.parse(commentId);

  const comment = await getCommentById(parsed);
  if (!comment) return;

  if (comment.userId !== user.id && user.role !== "ADMIN") {
    throw new ForbiddenError("You can only delete your own comments.");
  }

  await deleteCommentById(parsed);
}
