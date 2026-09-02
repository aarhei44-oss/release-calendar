import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: vi.fn() };
});

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { addComment, deleteComment } from "@/app/calendar/actions";

const mockGetServerSession = vi.mocked(getServerSession);

function sessionFor(user: { id: string; role?: "USER" | "ADMIN" }) {
  return {
    user: { id: user.id, role: user.role ?? "USER", active: true },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

let eventId: string;
let author: { id: string };
let otherUser: { id: string };
let admin: { id: string };

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: { slug: "comments-test", name: "Comments Test", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  const productSet = await prisma.productSet.create({
    data: { tcgProfileInstallId: install.id, code: "CT-1", name: "Comments Test Set" },
  });
  const event = await prisma.releaseEvent.create({
    data: { productSetId: productSet.id, type: "SHELF", dateType: "TBD", status: "RUMORED" },
  });
  eventId = event.id;

  author = await prisma.user.create({ data: { email: "comment-author@example.com" } });
  otherUser = await prisma.user.create({ data: { email: "comment-other@example.com" } });
  admin = await prisma.user.create({ data: { email: "comment-admin@example.com", role: "ADMIN" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("addComment", () => {
  it("requires a signed-in user", async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    await expect(addComment({ eventId, content: "hi" })).rejects.toThrow();
  });

  it("persists a comment for the signed-in user", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(author));
    const comment = await addComment({ eventId, content: "First comment" });
    expect(comment.userId).toBe(author.id);
    expect(comment.content).toBe("First comment");
  });

  it("rejects empty content", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(author));
    await expect(addComment({ eventId, content: "   " })).rejects.toThrow();
  });
});

describe("deleteComment", () => {
  it("allows the author to delete their own comment", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(author));
    const comment = await addComment({ eventId, content: "to be deleted by author" });

    mockGetServerSession.mockResolvedValueOnce(sessionFor(author));
    await deleteComment(comment.id);

    const found = await prisma.userNote.findUnique({ where: { id: comment.id } });
    expect(found).toBeNull();
  });

  it("rejects a non-author, non-admin user", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(author));
    const comment = await addComment({ eventId, content: "owned by author" });

    mockGetServerSession.mockResolvedValueOnce(sessionFor(otherUser));
    await expect(deleteComment(comment.id)).rejects.toThrow();

    const stillThere = await prisma.userNote.findUnique({ where: { id: comment.id } });
    expect(stillThere).not.toBeNull();
  });

  it("allows an admin to delete any user's comment", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(author));
    const comment = await addComment({ eventId, content: "owned by author, deleted by admin" });

    mockGetServerSession.mockResolvedValueOnce(sessionFor(admin));
    await deleteComment(comment.id);

    const found = await prisma.userNote.findUnique({ where: { id: comment.id } });
    expect(found).toBeNull();
  });
});
