import { prisma } from "@/lib/prisma";

export async function getProfile(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { timezone: true },
  });
}

export async function updateTimezone(userId: string, timezone: string | null) {
  return prisma.user.update({
    where: { id: userId },
    data: { timezone },
    select: { timezone: true },
  });
}
