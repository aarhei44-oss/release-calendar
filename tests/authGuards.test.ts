import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: vi.fn() };
});

import { getServerSession } from "next-auth";
import { requireUser, requireAdmin, UnauthorizedError, ForbiddenError } from "@/lib/authGuards";

const mockGetServerSession = vi.mocked(getServerSession);

function sessionWith(user: Partial<{ id: string; role: "USER" | "ADMIN"; active: boolean }>) {
  return {
    user: { id: "u1", role: "USER" as const, active: true, ...user },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("requireUser", () => {
  it("throws UnauthorizedError when there is no session", async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    await expect(requireUser()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("throws UnauthorizedError when the user is inactive", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionWith({ active: false }));
    await expect(requireUser()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("returns the user when signed in and active", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionWith({ id: "u42" }));
    const user = await requireUser();
    expect(user.id).toBe("u42");
  });
});

describe("requireAdmin", () => {
  it("throws UnauthorizedError when there is no session", async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    await expect(requireAdmin()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("throws ForbiddenError for a signed-in non-admin user", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionWith({ role: "USER" }));
    await expect(requireAdmin()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("returns the user for a signed-in admin", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionWith({ role: "ADMIN" }));
    const user = await requireAdmin();
    expect(user.role).toBe("ADMIN");
  });
});
