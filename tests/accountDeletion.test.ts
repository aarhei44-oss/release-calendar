import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { deleteMyAccount } from "@/app/profile/actions";

const mockGetServerSession = vi.mocked(getServerSession);
const mockCancel = vi.mocked(cancelStripeSubscription);

function sessionFor(user: { id: string }) {
  return {
    user: { id: user.id, role: "USER", active: true },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

let counter = 0;
async function createUser(data: { stripeSubscriptionId?: string } = {}) {
  counter += 1;
  return prisma.user.create({ data: { email: `delete-me-${counter}-${Date.now()}@example.com`, ...data } });
}

beforeEach(() => {
  mockCancel.mockReset();
  mockCancel.mockResolvedValue(undefined);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("deleteMyAccount", () => {
  it("requires a signed-in user", async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    await expect(deleteMyAccount("DELETE")).rejects.toThrow();
  });

  it("refuses without the exact confirmation word and leaves the account intact", async () => {
    const user = await createUser();
    for (const wrong of ["", "delete", "DELETE ", "yes"]) {
      mockGetServerSession.mockResolvedValueOnce(sessionFor(user));
      await expect(deleteMyAccount(wrong)).rejects.toThrow();
    }
    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
  });

  it("deletes the user and cascades to everything attached to them", async () => {
    const user = await createUser();
    await prisma.account.create({
      data: { userId: user.id, type: "oauth", provider: "google", providerAccountId: `g-${user.id}` },
    });
    await prisma.session.create({
      data: { userId: user.id, sessionToken: `tok-${user.id}`, expires: new Date(Date.now() + 60_000) },
    });

    mockGetServerSession.mockResolvedValueOnce(sessionFor(user));
    await deleteMyAccount("DELETE");

    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await prisma.account.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it("does not touch other users", async () => {
    const doomed = await createUser();
    const bystander = await createUser();

    mockGetServerSession.mockResolvedValueOnce(sessionFor(doomed));
    await deleteMyAccount("DELETE");

    expect(await prisma.user.findUnique({ where: { id: bystander.id } })).not.toBeNull();
  });

  it("cancels the Stripe subscription before deleting the user", async () => {
    const user = await createUser({ stripeSubscriptionId: `sub_${Date.now()}` });
    mockCancel.mockImplementationOnce(async () => {
      // At the moment of cancellation the account must still exist.
      expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
    });

    mockGetServerSession.mockResolvedValueOnce(sessionFor(user));
    await deleteMyAccount("DELETE");

    expect(mockCancel).toHaveBeenCalledWith(user.stripeSubscriptionId);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
  });

  it("aborts and keeps the account when the subscription can't be cancelled", async () => {
    const user = await createUser({ stripeSubscriptionId: `sub_fail_${Date.now()}` });
    mockCancel.mockRejectedValueOnce(new Error("stripe is down"));

    mockGetServerSession.mockResolvedValueOnce(sessionFor(user));
    await expect(deleteMyAccount("DELETE")).rejects.toThrow("stripe is down");

    expect(await prisma.user.findUnique({ where: { id: user.id } })).not.toBeNull();
  });
});
