import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/ical/[token]/feed.ics/route";

afterAll(async () => {
  await prisma.$disconnect();
});

function req() {
  return new Request("http://localhost/api/ical/x/feed.ics");
}

describe("GET /api/ical/[token]/feed.ics", () => {
  it("returns 404 for an unknown token", async () => {
    const response = await GET(req(), { params: Promise.resolve({ token: "does-not-exist" }) });
    expect(response.status).toBe(404);
  });

  it("returns 404 for a real token belonging to a non-premium user", async () => {
    const user = await prisma.user.create({
      data: { email: `ical-${crypto.randomUUID()}@example.com`, isPremium: false, icalToken: "free-user-token" },
    });
    const response = await GET(req(), { params: Promise.resolve({ token: "free-user-token" }) });
    expect(response.status).toBe(404);
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("serves an ICS feed for a premium user's token, scoped to their subscriptions", async () => {
    const pkg = await prisma.tcgProfilePackage.create({
      data: { slug: `ical-route-test-${crypto.randomUUID()}`, name: "Ical Route Test", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
    });
    const install = await prisma.tcgProfileInstall.create({
      data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
    });
    const productSet = await prisma.productSet.create({
      data: { tcgProfileInstallId: install.id, code: "IR-1", name: "Ical Route Test Set" },
    });
    const user = await prisma.user.create({
      data: { email: `ical-${crypto.randomUUID()}@example.com`, isPremium: true, icalToken: "premium-user-token" },
    });
    await prisma.subscription.create({ data: { userId: user.id, tcgProfileInstallId: install.id } });
    await prisma.releaseEvent.create({
      data: {
        productSetId: productSet.id,
        type: "SHELF",
        dateType: "EXACT",
        dateExact: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        status: "CONFIRMED",
        confidence: 0.9,
      },
    });

    const response = await GET(req(), { params: Promise.resolve({ token: "premium-user-token" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/calendar");
    const body = await response.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("Ical Route Test Set");
  });
});
