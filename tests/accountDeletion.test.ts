import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: vi.fn() };
});

vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return { ...actual, cancelStripeSubscription: vi.fn() };
});

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { cancelStripeSubscription } from "@/lib/stripe";
import { authOptions } from "@/app/auth";
import { deleteMyAccount } from "@/app/profile/actions";
import { ACCOUNT_REMOVAL_GRACE_DAYS, removalDateFrom, runAccountRemovalPass } from "@/lib/accountRemoval";
import { getEventDetail } from "@/data/calendar/calendarRepo";
import { getDigestSubscribers, getSubscribersForInstalls } from "@/data/notifications/notificationsRepo";

const mockGetServerSession = vi.mocked(getServerSession);
const mockCancel = vi.mocked(cancelStripeSubscription);

const DAY_MS = 24 * 60 * 60 * 1000;

function sessionFor(user: { id: string }) {
  return {
    user: { id: user.id, role: "USER", active: true },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

let counter = 0;
async function createUser(data: Record<string, unknown> = {}) {
  counter += 1;
  return prisma.user.create({ data: { email: `delete-me-${counter}-${Date.now()}@example.com`, ...data } });
}

let installId: string;
let eventId: string;

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: { slug: `acct-del-${Date.now()}`, name: "Acct Del", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;
  const productSet = await prisma.productSet.create({
    data: { tcgProfileInstallId: install.id, code: "AD-1", name: "Acct Del Set" },
  });
  const event = await prisma.releaseEvent.create({
    data: { productSetId: productSet.id, type: "SHELF", dateType: "TBD", status: "RUMORED" },
  });
  eventId = event.id;
});

beforeEach(() => {
  mockCancel.mockReset();
  mockCancel.mockResolvedValue(undefined);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("removalDateFrom", () => {
  it("is exactly the grace period after the given time", () => {
    const now = new Date("2026-11-16T12:00:00Z");
    expect(removalDateFrom(now).getTime() - now.getTime()).toBe(ACCOUNT_REMOVAL_GRACE_DAYS * DAY_MS);
    expect(ACCOUNT_REMOVAL_GRACE_DAYS).toBe(30);
  });
});

describe("deleteMyAccount", () => {
  it("requires a signed-in user", async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    await expect(deleteMyAccount("DELETE")).rejects.toThrow();
  });

  it("refuses without the exact confirmation word and leaves the account untouched", async () => {
    const user = await createUser();
    for (const wrong of ["", "delete", "DELETE ", "yes"]) {
      mockGetServerSession.mockResolvedValueOnce(sessionFor(user));
      await expect(deleteMyAccount(wrong)).rejects.toThrow();
    }
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.removalDate).toBeNull();
    expect(after.active).toBe(true);
  });

  it("deactivates the account and schedules removal 30 days out, without erasing anything yet", async () => {
    const user = await createUser({
      isPremium: true,
      emailAlertsEnabled: true,
      discordAlertsEnabled: true,
      discordWebhookUrl: "https://discord.com/api/webhooks/1/abc",
      digestEmailEnabled: true,
      leadTimeReminderDays: 3,
      icalToken: `tok-${Date.now()}-${counter}`,
    });
    await prisma.account.create({
      data: { userId: user.id, type: "oauth", provider: "google", providerAccountId: `g-${user.id}` },
    });
    await prisma.session.create({
      data: { userId: user.id, sessionToken: `sess-${user.id}`, expires: new Date(Date.now() + 60_000) },
    });
    await prisma.subscription.create({ data: { userId: user.id, tcgProfileInstallId: installId } });

    const before = Date.now();
    mockGetServerSession.mockResolvedValueOnce(sessionFor(user));
    await deleteMyAccount("DELETE");

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.removalDate).not.toBeNull();
    expect(after.removalDate!.getTime() - before).toBeGreaterThanOrEqual(ACCOUNT_REMOVAL_GRACE_DAYS * DAY_MS - 1000);
    expect(after.removalDate!.getTime() - before).toBeLessThan(ACCOUNT_REMOVAL_GRACE_DAYS * DAY_MS + 60_000);

    // Inert: signed out, no alerts, no feed, no premium.
    expect(after.active).toBe(false);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(after.emailAlertsEnabled).toBe(false);
    expect(after.discordAlertsEnabled).toBe(false);
    expect(after.discordWebhookUrl).toBeNull();
    expect(after.digestEmailEnabled).toBe(false);
    expect(after.leadTimeReminderDays).toBeNull();
    expect(after.icalToken).toBeNull();
    expect(after.isPremium).toBe(false);

    // Not erased yet: the data is still there until the nightly pass runs.
    expect(await prisma.subscription.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.account.count({ where: { userId: user.id } })).toBe(1);
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it("does not touch other users", async () => {
    const doomed = await createUser();
    const bystander = await createUser();

    mockGetServerSession.mockResolvedValueOnce(sessionFor(doomed));
    await deleteMyAccount("DELETE");

    const other = await prisma.user.findUniqueOrThrow({ where: { id: bystander.id } });
    expect(other.removalDate).toBeNull();
    expect(other.active).toBe(true);
  });

  it("cancels the Stripe subscription before deactivating the account", async () => {
    const user = await createUser({ stripeSubscriptionId: `sub_${Date.now()}`, isPremium: true });
    mockCancel.mockImplementationOnce(async () => {
      // At the moment of cancellation the account must still be live.
      const live = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(live.removalDate).toBeNull();
    });

    mockGetServerSession.mockResolvedValueOnce(sessionFor(user));
    await deleteMyAccount("DELETE");

    expect(mockCancel).toHaveBeenCalledWith(user.stripeSubscriptionId);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.removalDate).not.toBeNull();
    expect(after.stripeSubscriptionId).toBeNull();
  });

  it("aborts and leaves the account live when the subscription can't be cancelled", async () => {
    const user = await createUser({ stripeSubscriptionId: `sub_fail_${Date.now()}` });
    mockCancel.mockRejectedValueOnce(new Error("stripe is down"));

    mockGetServerSession.mockResolvedValueOnce(sessionFor(user));
    await expect(deleteMyAccount("DELETE")).rejects.toThrow("stripe is down");

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.removalDate).toBeNull();
    expect(after.active).toBe(true);
  });
});

describe("runAccountRemovalPass", () => {
  it("erases accounts past their removal date, with everything attached, and nothing else", async () => {
    const due = await createUser({ removalDate: new Date(Date.now() - 1000) });
    const notYet = await createUser({ removalDate: new Date(Date.now() + 5 * DAY_MS) });
    const live = await createUser();

    for (const u of [due, notYet, live]) {
      await prisma.account.create({
        data: { userId: u.id, type: "oauth", provider: "google", providerAccountId: `g-${u.id}` },
      });
      await prisma.subscription.create({ data: { userId: u.id, tcgProfileInstallId: installId } });
      await prisma.userNote.create({ data: { userId: u.id, releaseEventId: eventId, content: "hi" } });
      await prisma.eventFollow.create({ data: { userId: u.id, releaseEventId: eventId } });
      await prisma.eventReaction.create({ data: { userId: u.id, releaseEventId: eventId, emoji: "🔥" } });
    }

    const result = await runAccountRemovalPass();
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0);

    expect(await prisma.user.findUnique({ where: { id: due.id } })).toBeNull();
    for (const table of [prisma.account, prisma.subscription, prisma.userNote, prisma.eventFollow, prisma.eventReaction]) {
      expect(await (table as typeof prisma.account).count({ where: { userId: due.id } })).toBe(0);
    }

    // Still-pending and live accounts are untouched, data included.
    expect(await prisma.user.findUnique({ where: { id: notYet.id } })).not.toBeNull();
    expect(await prisma.userNote.count({ where: { userId: notYet.id } })).toBe(1);
    expect(await prisma.user.findUnique({ where: { id: live.id } })).not.toBeNull();
    expect(await prisma.userNote.count({ where: { userId: live.id } })).toBe(1);
  });

  it("is idempotent: a second run has nothing left to delete", async () => {
    await createUser({ removalDate: new Date(Date.now() - 1000) });
    await runAccountRemovalPass();
    const second = await runAccountRemovalPass();
    expect(second).toEqual({ deleted: 0, errors: 0 });
  });

  it("catches up on accounts that went overdue while the server was down", async () => {
    const longOverdue = await createUser({ removalDate: new Date(Date.now() - 10 * DAY_MS) });
    await runAccountRemovalPass();
    expect(await prisma.user.findUnique({ where: { id: longOverdue.id } })).toBeNull();
  });
});

describe("a pending-deletion account is invisible while it waits", () => {
  it("hides its public comments but keeps everyone else's", async () => {
    const pending = await createUser({ removalDate: new Date(Date.now() + 10 * DAY_MS), active: false });
    const live = await createUser();
    await prisma.userNote.create({ data: { userId: pending.id, releaseEventId: eventId, content: "from pending" } });
    await prisma.userNote.create({ data: { userId: live.id, releaseEventId: eventId, content: "from live" } });

    const detail = await getEventDetail(eventId);
    const contents = detail!.userNotes.map((n) => n.content);
    expect(contents).toContain("from live");
    expect(contents).not.toContain("from pending");
  });

  it("is excluded from alert and digest recipient lists even if its flags were somehow still set", async () => {
    const pending = await createUser({
      removalDate: new Date(Date.now() + 10 * DAY_MS),
      isPremium: true,
      digestEmailEnabled: true,
      emailAlertsEnabled: true,
    });
    await prisma.subscription.create({ data: { userId: pending.id, tcgProfileInstallId: installId } });

    expect((await getDigestSubscribers()).map((s) => s.userId)).not.toContain(pending.id);
    expect((await getSubscribersForInstalls([installId])).map((s) => s.userId)).not.toContain(pending.id);
  });
});

describe("signing back in to a pending-deletion account", () => {
  const signIn = authOptions.callbacks!.signIn!;
  const call = (email: string | null) =>
    signIn({ user: { id: "x", email }, account: null, profile: undefined, email: undefined, credentials: undefined } as never);

  it("cancels the deletion and reactivates the account, keeping the settings deletion cleared", async () => {
    const user = await createUser({ isPremium: true, emailAlertsEnabled: true });
    mockGetServerSession.mockResolvedValueOnce(sessionFor(user));
    await deleteMyAccount("DELETE");

    expect(await call(user.email)).toBe(true);

    const restored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(restored.removalDate).toBeNull();
    expect(restored.active).toBe(true);
    // Deletion's cleared settings don't come back by themselves.
    expect(restored.emailAlertsEnabled).toBe(false);
    expect(restored.isPremium).toBe(false);

    // And the nightly pass no longer touches it.
    await runAccountRemovalPass(new Date(Date.now() + 60 * DAY_MS));
    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
  });

  it("leaves a normal account alone, and allows a brand-new email", async () => {
    const live = await createUser();
    expect(await call(live.email)).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: live.id } })).removalDate).toBeNull();
    expect(await call(`never-seen-${Date.now()}@example.com`)).toBe(true);
  });
});
