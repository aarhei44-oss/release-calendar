import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: vi.fn() };
});

const createSession = vi.fn();
vi.mock("@/lib/stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe")>();
  return { ...actual, getStripeClient: () => ({ checkout: { sessions: { create: createSession } } }) };
});

import { getServerSession } from "next-auth";
import { isCheckoutOpen } from "@/lib/stripe";
import { createCheckoutSession } from "@/app/premium/actions";

const ENV_KEYS = ["PREMIUM_CHECKOUT_OPEN", "STRIPE_SECRET_KEY", "STRIPE_PRICE_MONTHLY", "STRIPE_PRICE_ANNUAL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  // A dummy key is enough: constructing the real client makes no network call,
  // and it's what isCheckoutConfigured() (which bypasses the mock above) reads.
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PRICE_MONTHLY = "price_monthly_test";
  process.env.STRIPE_PRICE_ANNUAL = "price_annual_test";
  createSession.mockReset();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("Premium checkout launch switch", () => {
  it("is closed unless PREMIUM_CHECKOUT_OPEN is exactly 'true'", () => {
    for (const value of [undefined, "", "false", "1", "TRUE"]) {
      if (value === undefined) delete process.env.PREMIUM_CHECKOUT_OPEN;
      else process.env.PREMIUM_CHECKOUT_OPEN = value;
      expect(isCheckoutOpen()).toBe(false);
    }
  });

  it("is open when the switch is on and Stripe is configured", () => {
    process.env.PREMIUM_CHECKOUT_OPEN = "true";
    expect(isCheckoutOpen()).toBe(true);
  });

  it("refuses to create a Checkout Session while closed, even with Stripe configured", async () => {
    delete process.env.PREMIUM_CHECKOUT_OPEN;
    vi.mocked(getServerSession).mockResolvedValueOnce({
      user: { id: "u1", role: "USER", active: true, email: "a@example.com" },
      expires: new Date(Date.now() + 60_000).toISOString(),
    } as never);

    await expect(createCheckoutSession("monthly")).rejects.toThrow("isn't open yet");
    expect(createSession).not.toHaveBeenCalled();
  });
});
