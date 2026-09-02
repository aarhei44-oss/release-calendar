import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";

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

/** Throws UnauthorizedError if there is no active, signed-in user. */
export async function requireUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user || !session.user.active) {
    throw new UnauthorizedError();
  }
  return session.user;
}

/** Throws UnauthorizedError/ForbiddenError unless the signed-in user has the ADMIN role. */
export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== "ADMIN") {
    throw new ForbiddenError();
  }
  return user;
}
