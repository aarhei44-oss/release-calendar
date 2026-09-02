import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok", database: "up" });
  } catch (error) {
    return Response.json(
      { status: "error", database: "down", message: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }
}
