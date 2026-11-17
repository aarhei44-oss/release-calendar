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
import { banUser, unbanUser, cancelUserDeletion, deleteUser } from "@/app/admin/actions";
import { runAccountRemovalPass } from "@/lib/accountRemoval";
import { getEventDetail } from "@/data/calendar/calendarRepo";
import { getDigestSubscribers } from "@/data/notifications/notificationsRepo";

const mockGetServerSession = vi.mocked(getServerSession);
const mockCancel = vi.mocked(cancelStripeSubscription);

const DAY_MS = 24 * 60 * 60 * 1000;

function sessionFor(user: { id: string }, role: "USER" | "ADMIN" = "USER") {
  return {
    user: { id: user.id, role, active: true },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

let counter = 0;
async function createUser(data: Record<string, unknown> = {}) {
  counter += 1;
  return prisma.user.create({ data: { email: `ban-test-${counter}-${Date.now()}@example.com`, ...data } });
}

let admin: { id: string };
let eventId: string;

beforeAll(async () => {
  admin = await createUser({ role: "ADMIN" });
  const pkg = await prisma.tcgProfilePackage.create({
    data: { slug: `ban-test-${Date.now()}`, name: "Ban Test", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  const productSet = await prisma.productSet.create({
    data: { tcgProfileInstallId: install.id, code: "BT-1", name: "Ban Test Set" },
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

describe("banUser", () => {
  it("signs the user out, shuts off alerts and premium, and stamps the ban", async () => {
    const target = await createUser({
      isPremium: true,
      emailAlertsEnabled: true,
      digestEmailEnabled: true,
      icalToken: `ban-tok-${Date.now()}`,
    });
    await prisma.session.create({
      data: { userId: target.id, sessionToken: `ban-sess-${target.id}`, expires: new Date(Date.now() + 60_000) },
    });

    mockGetServerSession.mockResolvedValueOnce(sessionFor(admin, "ADMIN"));
    await banUser(target.id);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.bannedAt).not.toBeNull();
    expect(after.active).toBe(false);
    expect(after.isPremium).toBe(false);
    expect(after.emailAlertsEnabled).toBe(false);
    expect(after.digestEmailEnabled).toBe(false);
    expect(after.icalToken).toBeNull();
    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(0);
  });

  it("cancels the Stripe subscription before banning, and aborts if that fails", async () => {
    const target = await createUser({ stripeSubscriptionId: `sub_ban_${Date.now()}` });
    mockCancel.mockImplementationOnce(async () => {
      const live = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(live.bannedAt).toBeNull();
    });
    mockGetServerSession.mockResolvedValueOnce(sessionFor(admin, "ADMIN"));
    await banUser(target.id);
    expect(mockCancel).toHaveBeenCalledWith(target.stripeSubscriptionId);

    const failing = await createUser({ stripeSubscriptionId: `sub_ban_fail_${Date.now()}` });
    mockCancel.mockRejectedValueOnce(new Error("stripe is down"));
    mockGetServerSession.mockResolvedValueOnce(sessionFor(admin, "ADMIN"));
    await expect(banUser(failing.id)).rejects.toThrow("stripe is down");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: failing.id } })).bannedAt).toBeNull();
  });

  it("refuses to ban yourself or another admin", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(admin, "ADMIN"));
    await expect(banUser(admin.id)).rejects.toThrow(/cannot ban your own/i);

    const otherAdmin = await createUser({ role: "ADMIN" });
    mockGetServerSession.mockResolvedValueOnce(sessionFor(admin, "ADMIN"));
    await expect(banUser(otherAdmin.id)).rejects.toThrow(/admin role/i);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: otherAdmin.id } })).bannedAt).toBeNull();
  });

  it("rejects a non-admin caller", async () => {
    const plain = await createUser();
    const victim = await createUser();
    mockGetServerSession.mockResolvedValueOnce(sessionFor(plain));
    await expect(banUser(victim.id)).rejects.toThrow();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).bannedAt).toBeNull();
  });
});

describe("a banned account", () => {
  const signIn = authOptions.callbacks!.signIn!;
  const call = (email: string) =>
    signIn({ user: { id: "x", email }, account: null, profile: undefined, email: undefined, credentials: undefined } as never);

  it("can't sign in, and signing in does not lift a pending deletion or the ban", async () => {
    const target = await createUser({
      bannedAt: new Date(),
      active: false,
      removalDate: new Date(Date.now() + 10 * DAY_MS),
    });

    expect(await call(target.email)).toBe("/?accountSuspended=1");

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.bannedAt).not.toBeNull();
    expect(after.removalDate).not.toBeNull();
    expect(after.active).toBe(false);
  });

  it("is never erased by the nightly pass, even once its deletion date has passed", async () => {
    const target = await createUser({ bannedAt: new Date(), active: false, removalDate: new Date(Date.now() - DAY_MS) });
    await runAccountRemovalPass();
    expect(await prisma.user.findUnique({ where: { id: target.id } })).not.toBeNull();
  });

  it("has its comments hidden and is left out of recipient lists", async () => {
    const target = await createUser({ bannedAt: new Date(), active: false, isPremium: true, digestEmailEnabled: true });
    const other = await createUser();
    await prisma.userNote.create({ data: { userId: target.id, releaseEventId: eventId, content: "from banned" } });
    await prisma.userNote.create({ data: { userId: other.id, releaseEventId: eventId, content: "from fine" } });

    const contents = (await getEventDetail(eventId))!.userNotes.map((n) => n.content);
    expect(contents).toContain("from fine");
    expect(contents).not.toContain("from banned");
    expect((await getDigestSubscribers()).map((s) => s.userId)).not.toContain(target.id);
  });

  it("stays deactivated when an admin cancels its pending deletion", async () => {
    const target = await createUser({
      bannedAt: new Date(),
      active: false,
      removalDate: new Date(Date.now() + 10 * DAY_MS),
    });
    mockGetServerSession.mockResolvedValueOnce(sessionFor(admin, "ADMIN"));
    await cancelUserDeletion(target.id);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.removalDate).toBeNull();
    expect(after.active).toBe(false);
  });
});

describe("unbanUser", () => {
  it("lets the user sign in again and reactivates the account", async () => {
    const target = await createUser();
    mockGetServerSession.mockResolvedValueOnce(sessionFor(admin, "ADMIN"));
    await banUser(target.id);
    mockGetServerSession.mockResolvedValueOnce(sessionFor(admin, "ADMIN"));
    await unbanUser(target.id);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.bannedAt).toBeNull();
    expect(after.active).toBe(true);
  });

  it("keeps the account deactivated if a deletion is also pending", async () => {
    const target = await createUser();
    mockGetServerSession.mockResolvedValueOnce(sessionFor(admin, "ADMIN"));
    await deleteUser(target.id);
    mockGetServerSession.mockResolvedValueOnce(sessionFor(admin, "ADMIN"));
    await banUser(target.id);
    mockGetServerSession.mockResolvedValueOnce(sessionFor(admin, "ADMIN"));
    await unbanUser(target.id);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after.bannedAt).toBeNull();
    expect(after.removalDate).not.toBeNull();
    expect(after.active).toBe(false);
  });
});
