import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getSubscribersForInstalls } from "@/data/notifications/notificationsRepo";

let installId: string;

beforeEach(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: { slug: `notif-repo-test-${crypto.randomUUID()}`, name: "Notif Repo Test", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("getSubscribersForInstalls", () => {
  it("returns an empty list for an empty installIds array without querying", async () => {
    expect(await getSubscribersForInstalls([])).toEqual([]);
  });

  it("returns a subscriber's alert preferences alongside their subscription", async () => {
    const user = await prisma.user.create({
      data: {
        email: `notif-repo-${crypto.randomUUID()}@example.com`,
        emailAlertsEnabled: true,
        discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
        discordAlertsEnabled: true,
      },
    });
    await prisma.subscription.create({ data: { userId: user.id, tcgProfileInstallId: installId } });

    const result = await getSubscribersForInstalls([installId]);

    expect(result).toEqual([
      {
        userId: user.id,
        installId,
        email: user.email,
        emailAlertsEnabled: true,
        discordWebhookUrl: "https://discord.com/api/webhooks/123/abc",
        discordAlertsEnabled: true,
      },
    ]);
  });

  it("excludes users not subscribed to any of the given installs", async () => {
    const otherPkg = await prisma.tcgProfilePackage.create({
      data: { slug: `notif-repo-other-${crypto.randomUUID()}`, name: "Other", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
    });
    const otherInstall = await prisma.tcgProfileInstall.create({
      data: { packageId: otherPkg.id, installedVersion: "1.0.0", enabled: true },
    });
    const user = await prisma.user.create({ data: { email: `notif-repo-${crypto.randomUUID()}@example.com` } });
    await prisma.subscription.create({ data: { userId: user.id, tcgProfileInstallId: otherInstall.id } });

    const result = await getSubscribersForInstalls([installId]);

    expect(result).toEqual([]);
  });
});
