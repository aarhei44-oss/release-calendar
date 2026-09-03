import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: vi.fn() };
});

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/events/[eventId]/ics/route";

const mockGetServerSession = vi.mocked(getServerSession);

function sessionFor(overrides: { isPremium?: boolean } = {}) {
  return {
    user: { id: "session-user", role: "USER" as const, active: true, isPremium: overrides.isPremium ?? false },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

function req() {
  return new Request("http://localhost/api/events/x/ics");
}

let eventId: string;

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: { slug: `event-ics-route-test-${crypto.randomUUID()}`, name: "Event Ics Route Test", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  const productSet = await prisma.productSet.create({
    data: { tcgProfileInstallId: install.id, code: "EIR-1", name: "Event Ics Route Test Set" },
  });
  const event = await prisma.releaseEvent.create({
    data: {
      productSetId: productSet.id,
      type: "SHELF",
      dateType: "EXACT",
      dateExact: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      status: "CONFIRMED",
      confidence: 0.9,
    },
  });
  eventId = event.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/events/[eventId]/ics", () => {
  it("returns 403 for a signed-out caller", async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    const response = await GET(req(), { params: Promise.resolve({ eventId }) });
    expect(response.status).toBe(403);
  });

  it("returns 403 for a signed-in, non-premium caller", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor({ isPremium: false }));
    const response = await GET(req(), { params: Promise.resolve({ eventId }) });
    expect(response.status).toBe(403);
  });

  it("returns 404 for an unknown event, even for a premium caller", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor({ isPremium: true }));
    const response = await GET(req(), { params: Promise.resolve({ eventId: "does-not-exist" }) });
    expect(response.status).toBe(404);
  });

  it("serves a single-event ICS download for a premium caller", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor({ isPremium: true }));
    const response = await GET(req(), { params: Promise.resolve({ eventId }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/calendar");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Content-Disposition")).toContain(".ics");
    const body = await response.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("Event Ics Route Test Set");
  });
});
