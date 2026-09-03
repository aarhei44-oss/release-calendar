import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import { logEvent } from "./logger";

export class UnauthorizedError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  constructor(message = "Admin role required") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class PremiumRequiredError extends Error {
  constructor(message = "Premium required") {
    super(message);
    this.name = "PremiumRequiredError";
  }
}

/** Throws UnauthorizedError if there is no active, signed-in user. */
export async function requireUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user || !session.user.active) {
    logEvent({ event: "auth.requireUser", outcome: "denied" });
    throw new UnauthorizedError();
  }
  logEvent({ event: "auth.requireUser", outcome: "allowed", userId: session.user.id });
  return session.user;
}

/** Throws UnauthorizedError/ForbiddenError unless the signed-in user has the ADMIN role. */
export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== "ADMIN") {
    logEvent({ event: "auth.requireAdmin", outcome: "denied", userId: user.id });
    throw new ForbiddenError();
  }
  logEvent({ event: "auth.requireAdmin", outcome: "allowed", userId: user.id });
  return user;
}

/**
 * Throws UnauthorizedError/PremiumRequiredError unless the signed-in user
 * is premium. No billing exists yet -- isPremium is currently only set
 * manually from /admin's Users tab -- but every premium-gated server
 * action should still go through this so the check is enforced
 * server-side, not just hidden/disabled in the UI.
 */
export async function requirePremium() {
  const user = await requireUser();
  if (!user.isPremium) {
    logEvent({ event: "auth.requirePremium", outcome: "denied", userId: user.id });
    throw new PremiumRequiredError();
  }
  logEvent({ event: "auth.requirePremium", outcome: "allowed", userId: user.id });
  return user;
}
