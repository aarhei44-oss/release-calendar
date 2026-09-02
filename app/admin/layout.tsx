import type { ReactNode } from "react";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/app/auth";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    redirect("/");
  }

  if (session.user.role !== "ADMIN") {
    return (
      <div className="p-12 text-center">
        <h1 className="text-xl font-semibold">403 — Admin access required</h1>
        <p className="mt-2 text-gray-600">You don&apos;t have permission to view this page.</p>
      </div>
    );
  }

  return <>{children}</>;
}
