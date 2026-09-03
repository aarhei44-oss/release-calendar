"use server";

import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import {
  getFilteredEvents as repoGetFilteredEvents,
  getEventDetail as repoGetEventDetail,
  createComment,
  getCommentById,
  deleteCommentById,
} from "@/data/calendar/calendarRepo";
import { stripPremiumImageUrls, stripDescriptionForAnonymous } from "./eventDisplay";
import {
  followEvent as repoFollowEvent,
  unfollowEvent as repoUnfollowEvent,
  dismissEvent as repoDismissEvent,
  undismissEvent as repoUndismissEvent,
  savePersonalNote as repoSavePersonalNote,
  getEventPersonalization as repoGetEventPersonalization,
} from "@/data/events/eventPersonalizationRepo";
import { requireUser, requirePremium, ForbiddenError } from "@/lib/authGuards";
import { checkRateLimit } from "@/lib/rateLimit";
import { withActionLogging } from "@/lib/logger";

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
  return withActionLogging("calendar.getFilteredEvents", async () => {
    const filters = filtersSchema.parse(input);
    const events = await repoGetFilteredEvents(filters);
    const session = await getServerSession(authOptions);
    const withoutImages = stripPremiumImageUrls(events, session?.user?.isPremium ?? false);
    return stripDescriptionForAnonymous(withoutImages, !!session?.user);
  });
}

const eventIdSchema = z.string().min(1);

/**
 * Strips productSet.imageUrl for a non-premium (or anonymous) caller
 * rather than leaving that to the client to hide -- getEventDetail's
 * return value is the server action's wire payload, sent to every caller
 * regardless of what the UI later chooses to render from it. Leaving the
 * real URL in a response the client just blurs with CSS would mean the
 * "premium" asset is one Network-tab inspection away from anyone, premium
 * or not. hasMarketingImage lets the UI still show a locked/upsell state
 * without needing the URL itself. description gets the same treatment for
 * signed-out visitors -- it's free once signed in, not premium, but still
 * shouldn't ride along in the payload to an anonymous caller; hasDescription
 * lets the drawer show a "sign in to view" prompt without the text itself.
 */
export async function getEventDetail(eventId: string) {
  return withActionLogging("calendar.getEventDetail", async () => {
    const parsed = eventIdSchema.parse(eventId);
    const detail = await repoGetEventDetail(parsed);
    if (!detail) return detail;

    const session = await getServerSession(authOptions);
    const isPremium = session?.user?.isPremium ?? false;
    const isLoggedIn = !!session?.user;

    return {
      ...detail,
      productSet: {
        ...detail.productSet,
        imageUrl: isPremium ? detail.productSet.imageUrl : null,
        hasMarketingImage: detail.productSet.imageUrl !== null,
        description: isLoggedIn ? detail.productSet.description : null,
        hasDescription: !!detail.productSet.description,
      },
    };
  });
}

const addCommentSchema = z.object({
  eventId: z.string().min(1),
  content: z.string().trim().min(1).max(2000),
});

export async function addComment(input: z.infer<typeof addCommentSchema>) {
  return withActionLogging("calendar.addComment", async () => {
    const user = await requireUser();
    const { eventId, content } = addCommentSchema.parse(input);
    checkRateLimit(`addComment:${user.id}`, { max: 10, windowMs: 60_000 });
    return createComment({ userId: user.id, releaseEventId: eventId, content });
  });
}

export async function deleteComment(commentId: string) {
  return withActionLogging("calendar.deleteComment", async () => {
    const user = await requireUser();
    const parsed = eventIdSchema.parse(commentId);

    const comment = await getCommentById(parsed);
    if (!comment) return;

    if (comment.userId !== user.id && user.role !== "ADMIN") {
      throw new ForbiddenError("You can only delete your own comments.");
    }

    await deleteCommentById(parsed);
  });
}

// Premium event-level personalization (item 24): follow, "not interested",
// and a private note, all scoped per (user, event) -- distinct from the
// public comment thread above (UserNote/CommentsForEvent), which every
// viewer can see.

/** Read is allowed for any signed-in user (not premium-gated), so a lapsed-premium user can still see their own past follow/note/dismissal state; only the write actions below require active premium. */
export async function getEventPersonalization(eventId: string) {
  return withActionLogging("calendar.getEventPersonalization", async () => {
    const user = await requireUser();
    const parsed = eventIdSchema.parse(eventId);
    return repoGetEventPersonalization(user.id, parsed);
  });
}

export async function followEvent(eventId: string) {
  return withActionLogging("calendar.followEvent", async () => {
    const user = await requirePremium();
    const parsed = eventIdSchema.parse(eventId);
    return repoFollowEvent(user.id, parsed);
  });
}

export async function unfollowEvent(eventId: string) {
  return withActionLogging("calendar.unfollowEvent", async () => {
    const user = await requirePremium();
    const parsed = eventIdSchema.parse(eventId);
    return repoUnfollowEvent(user.id, parsed);
  });
}

export async function dismissEvent(eventId: string) {
  return withActionLogging("calendar.dismissEvent", async () => {
    const user = await requirePremium();
    const parsed = eventIdSchema.parse(eventId);
    return repoDismissEvent(user.id, parsed);
  });
}

export async function undismissEvent(eventId: string) {
  return withActionLogging("calendar.undismissEvent", async () => {
    const user = await requirePremium();
    const parsed = eventIdSchema.parse(eventId);
    return repoUndismissEvent(user.id, parsed);
  });
}

const personalNoteSchema = z.string().trim().max(2000);

export async function savePersonalNote(eventId: string, content: string) {
  return withActionLogging("calendar.savePersonalNote", async () => {
    const user = await requirePremium();
    const parsedEventId = eventIdSchema.parse(eventId);
    const parsedContent = personalNoteSchema.parse(content);
    return repoSavePersonalNote(user.id, parsedEventId, parsedContent);
  });
}
