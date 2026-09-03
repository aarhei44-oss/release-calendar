import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { runDigestPass } from "@/lib/notifications/digestScheduler";
import { getDigestSubscribers } from "@/data/notifications/notificationsRepo";

afterAll(async () => {
  await prisma.$disconnect();
});

async function createUser(overrides: {
  isPremium?: boolean;
  digestEmailEnabled?: boolean;
  digestFrequency?: "DAILY" | "WEEKLY";
} = {}) {
  return prisma.user.create({
    data: {
      email: `digest-${crypto.randomUUID()}@example.com`,
      isPremium: overrides.isPremium ?? true,
      digestEmailEnabled: overrides.digestEmailEnabled ?? true,
      digestFrequency: overrides.digestFrequency ?? "DAILY",
    },
  });
}

describe("getDigestSubscribers", () => {
  it("excludes a non-premium user even with the digest flag on (e.g. a lapsed premium period)", async () => {
    const user = await createUser({ isPremium: false });
    const subscribers = await getDigestSubscribers();
    expect(subscribers.map((s) => s.userId)).not.toContain(user.id);
  });

  it("excludes a premium user who hasn't opted in", async () => {
    const user = await createUser({ digestEmailEnabled: false });
    const subscribers = await getDigestSubscribers();
    expect(subscribers.map((s) => s.userId)).not.toContain(user.id);
  });

  it("includes a premium, opted-in user with their chosen frequency", async () => {
    const user = await createUser({ digestFrequency: "WEEKLY" });
    const subscribers = await getDigestSubscribers();
    const found = subscribers.find((s) => s.userId === user.id);
    expect(found?.frequency).toBe("WEEKLY");
  });
});

// 2026-01-19 is a Monday in America/Los_Angeles; 2026-01-20 is a Tuesday.
const A_MONDAY = new Date("2026-01-19T16:00:00.000Z"); // 08:00 PST Monday
const A_TUESDAY = new Date("2026-01-20T16:00:00.000Z"); // 08:00 PST Tuesday

describe("runDigestPass", () => {
  beforeEach(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: "digest-" } } });
  });

  it("sends to a DAILY subscriber regardless of the day", async () => {
    await createUser({ digestFrequency: "DAILY" });
    const result = await runDigestPass(A_TUESDAY);
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("skips a WEEKLY subscriber on a non-send day", async () => {
    await createUser({ digestFrequency: "WEEKLY" });
    const result = await runDigestPass(A_TUESDAY);
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("sends to a WEEKLY subscriber on the weekly send day", async () => {
    await createUser({ digestFrequency: "WEEKLY" });
    const result = await runDigestPass(A_MONDAY);
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(0);
  });
});
