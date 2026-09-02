import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/app/auth";

afterAll(async () => {
  await prisma.$disconnect();
});

async function createUser(email: string) {
  return prisma.user.create({ data: { email } });
}

describe("ADMIN_EMAILS bootstrap (authOptions.events.createUser)", () => {
  it("promotes a newly created user whose email is in ADMIN_EMAILS", async () => {
    const user = await createUser("admin@example.com");
    expect(user.role).toBe("USER");

    await authOptions.events?.createUser?.({ user });

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.role).toBe("ADMIN");
  });

  it("matches ADMIN_EMAILS case-insensitively", async () => {
    const user = await createUser("other.admin@example.com");

    await authOptions.events?.createUser?.({ user });

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.role).toBe("ADMIN");
  });

  it("leaves a non-admin email's role untouched", async () => {
    const user = await createUser("regular@example.com");

    await authOptions.events?.createUser?.({ user });

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.role).toBe("USER");
  });
});
