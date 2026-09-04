import type { UserRole } from "@/app/generated/prisma/client";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: UserRole;
      active: boolean;
      timezone: string | null;
      isPremium: boolean;
      stripeCustomerId: string | null;
      premiumCurrentPeriodEnd: Date | null;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }

  interface User {
    role: UserRole;
    active: boolean;
    timezone: string | null;
    isPremium: boolean;
    stripeCustomerId: string | null;
    premiumCurrentPeriodEnd: Date | null;
  }
}
