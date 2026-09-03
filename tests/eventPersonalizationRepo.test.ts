import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  followEvent,
  unfollowEvent,
  dismissEvent,
  undismissEvent,
  savePersonalNote,
  getEventPersonalization,
  getDismissedEventIds,
  setEventReaction,
  clearEventReaction,
  getEventReactionSummary,
  getReactionScoresForEvents,
} from "@/data/events/eventPersonalizationRepo";

let userId: string;
let eventId: string;
let otherEventId: string;

beforeEach(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: { slug: `event-personalization-test-${crypto.randomUUID()}`, name: "Event Personalization Test", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  const productSet = await prisma.productSet.create({
    data: { tcgProfileInstallId: install.id, code: "EP-1", name: "Event Personalization Test Set" },
  });
  const event = await prisma.releaseEvent.create({
    data: { productSetId: productSet.id, type: "SHELF", dateType: "EXACT", dateExact: new Date("2026-05-01"), status: "ANNOUNCED", confidence: 0.4 },
  });
  const otherEvent = await prisma.releaseEvent.create({
    data: { productSetId: productSet.id, type: "PROMO", dateType: "TBD", status: "RUMORED", confidence: 0.1 },
  });
  eventId = event.id;
  otherEventId = otherEvent.id;

  const user = await prisma.user.create({ data: { email: `event-personalization-${crypto.randomUUID()}@example.com` } });
  userId = user.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("getEventPersonalization", () => {
  it("returns all-false/null defaults for an event the user has no state on", async () => {
    const result = await getEventPersonalization(userId, eventId);
    expect(result).toEqual({ isFollowed: false, isDismissed: false, personalNote: null });
  });
});

describe("followEvent / unfollowEvent", () => {
  it("marks an event as followed", async () => {
    await followEvent(userId, eventId);
    expect((await getEventPersonalization(userId, eventId)).isFollowed).toBe(true);
  });

  it("is idempotent -- following twice doesn't error or duplicate", async () => {
    await followEvent(userId, eventId);
    await expect(followEvent(userId, eventId)).resolves.not.toThrow();
    const rows = await prisma.eventFollow.findMany({ where: { userId, releaseEventId: eventId } });
    expect(rows).toHaveLength(1);
  });

  it("unfollows", async () => {
    await followEvent(userId, eventId);
    await unfollowEvent(userId, eventId);
    expect((await getEventPersonalization(userId, eventId)).isFollowed).toBe(false);
  });

  it("does not affect a different event", async () => {
    await followEvent(userId, eventId);
    expect((await getEventPersonalization(userId, otherEventId)).isFollowed).toBe(false);
  });
});

describe("dismissEvent / undismissEvent", () => {
  it("marks an event as dismissed", async () => {
    await dismissEvent(userId, eventId);
    expect((await getEventPersonalization(userId, eventId)).isDismissed).toBe(true);
  });

  it("undismisses", async () => {
    await dismissEvent(userId, eventId);
    await undismissEvent(userId, eventId);
    expect((await getEventPersonalization(userId, eventId)).isDismissed).toBe(false);
  });
});

describe("getDismissedEventIds", () => {
  it("returns only this user's dismissed event ids", async () => {
    await dismissEvent(userId, eventId);
    const otherUser = await prisma.user.create({ data: { email: `event-personalization-other-${crypto.randomUUID()}@example.com` } });
    await dismissEvent(otherUser.id, otherEventId);

    const ids = await getDismissedEventIds(userId);
    expect(ids).toEqual([eventId]);
  });
});

describe("savePersonalNote", () => {
  it("creates a note", async () => {
    await savePersonalNote(userId, eventId, "Remember to check this at launch");
    expect((await getEventPersonalization(userId, eventId)).personalNote).toBe("Remember to check this at launch");
  });

  it("overwrites an existing note rather than creating a second one", async () => {
    await savePersonalNote(userId, eventId, "first draft");
    await savePersonalNote(userId, eventId, "final version");
    expect((await getEventPersonalization(userId, eventId)).personalNote).toBe("final version");
    const rows = await prisma.eventPersonalNote.findMany({ where: { userId, releaseEventId: eventId } });
    expect(rows).toHaveLength(1);
  });

  it("deletes the note when saved with an empty string", async () => {
    await savePersonalNote(userId, eventId, "something");
    await savePersonalNote(userId, eventId, "");
    expect((await getEventPersonalization(userId, eventId)).personalNote).toBeNull();
  });

  it("is invisible to a different user (private, not a shared comment)", async () => {
    await savePersonalNote(userId, eventId, "my private note");
    const otherUser = await prisma.user.create({ data: { email: `event-personalization-other2-${crypto.randomUUID()}@example.com` } });
    expect((await getEventPersonalization(otherUser.id, eventId)).personalNote).toBeNull();
  });
});

describe("setEventReaction / clearEventReaction / getEventReactionSummary", () => {
  it("returns empty counts and null myReaction for an event no one has reacted to", async () => {
    expect(await getEventReactionSummary(eventId)).toEqual({ counts: {}, myReaction: null });
  });

  it("sets a reaction and reflects it in both counts and myReaction", async () => {
    await setEventReaction(userId, eventId, "\u{1F525}");
    expect(await getEventReactionSummary(eventId, userId)).toEqual({
      counts: { "\u{1F525}": 1 },
      myReaction: "\u{1F525}",
    });
  });

  it("changes an existing reaction rather than adding a second row", async () => {
    await setEventReaction(userId, eventId, "\u{1F525}");
    await setEventReaction(userId, eventId, "\u{1F60D}");

    const rows = await prisma.eventReaction.findMany({ where: { userId, releaseEventId: eventId } });
    expect(rows).toHaveLength(1);
    expect(await getEventReactionSummary(eventId, userId)).toEqual({
      counts: { "\u{1F60D}": 1 },
      myReaction: "\u{1F60D}",
    });
  });

  it("clears a reaction", async () => {
    await setEventReaction(userId, eventId, "\u{1F525}");
    await clearEventReaction(userId, eventId);
    expect(await getEventReactionSummary(eventId, userId)).toEqual({ counts: {}, myReaction: null });
  });

  it("does not affect a different event", async () => {
    await setEventReaction(userId, eventId, "\u{1F525}");
    expect(await getEventReactionSummary(otherEventId, userId)).toEqual({ counts: {}, myReaction: null });
  });

  it("aggregates multiple users' reactions and only reports myReaction for the given user", async () => {
    const otherUser = await prisma.user.create({ data: { email: `event-personalization-other3-${crypto.randomUUID()}@example.com` } });
    await setEventReaction(userId, eventId, "\u{1F525}");
    await setEventReaction(otherUser.id, eventId, "\u{1F525}");

    expect(await getEventReactionSummary(eventId, userId)).toEqual({
      counts: { "\u{1F525}": 2 },
      myReaction: "\u{1F525}",
    });
    expect(await getEventReactionSummary(eventId)).toEqual({ counts: { "\u{1F525}": 2 }, myReaction: null });
  });
});

describe("getReactionScoresForEvents", () => {
  it("returns an empty map for an empty id list", async () => {
    expect(await getReactionScoresForEvents([])).toEqual(new Map());
  });

  it("omits events with no reactions", async () => {
    const scores = await getReactionScoresForEvents([eventId, otherEventId]);
    expect(scores.size).toBe(0);
  });

  it("buckets positive and negative emoji separately and ignores the neutral one", async () => {
    const otherUser = await prisma.user.create({ data: { email: `event-personalization-scores-${crypto.randomUUID()}@example.com` } });
    await setEventReaction(userId, eventId, "\u{1F525}"); // Hype (positive)
    await setEventReaction(otherUser.id, eventId, "\u{1F60D}"); // Want it (positive)
    await setEventReaction(userId, otherEventId, "\u{1F614}"); // Meh (negative)

    const scores = await getReactionScoresForEvents([eventId, otherEventId]);
    expect(scores.get(eventId)).toEqual({ positive: 2, negative: 0 });
    expect(scores.get(otherEventId)).toEqual({ positive: 0, negative: 1 });
  });

  it("only reports scores for the requested event ids", async () => {
    await setEventReaction(userId, otherEventId, "\u{1F525}");
    const scores = await getReactionScoresForEvents([eventId]);
    expect(scores.has(otherEventId)).toBe(false);
  });
});
