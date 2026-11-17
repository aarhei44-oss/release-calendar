import { type NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { cancelUserRemoval } from "@/data/profile/profileRepo";

function isBootstrapAdminEmail(email: string | null | undefined) {
  if (!email) return false;
  const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return adminEmails.includes(email.toLowerCase());
}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database" },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  ],
  events: {
    async createUser({ user }) {
      if (isBootstrapAdminEmail(user.email)) {
        await prisma.user.update({
          where: { id: user.id },
          data: { role: "ADMIN" },
        });
      }
    },
  },
  callbacks: {
    // Banned accounts can't sign in at all (checked first, so a ban also
    // beats a pending deletion). An account the user deleted stays in the
    // database until the nightly removal pass erases it
    // (lib/accountRemoval.ts); signing back in during that window cancels the
    // deletion: the account comes back as it was, minus the alert settings
    // and Premium that deletion cleared.
    async signIn({ user }) {
      if (!user.email) return true;
      const existing = await prisma.user.findUnique({
        where: { email: user.email },
        select: { id: true, removalDate: true, bannedAt: true },
      });
      if (existing?.bannedAt) return "/?accountSuspended=1";
      if (existing?.removalDate) {
        await cancelUserRemoval(existing.id);
      }
      return true;
    },
    async session({ session, user }) {
      session.user.id = user.id;
      session.user.role = user.role;
      session.user.active = user.active;
      session.user.timezone = user.timezone;
      session.user.isPremium = user.isPremium;
      session.user.stripeCustomerId = user.stripeCustomerId;
      session.user.premiumCurrentPeriodEnd = user.premiumCurrentPeriodEnd;
      return session;
    },
  },
};
