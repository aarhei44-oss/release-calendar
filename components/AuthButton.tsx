"use client";

import Link from "next/link";
import { signIn, signOut, useSession } from "next-auth/react";

export function AuthButton() {
  const { data: session, status } = useSession();

  if (status === "loading") {
    return <span className="text-sm text-gray-500">Loading…</span>;
  }

  if (!session?.user) {
    return (
      <button
        type="button"
        onClick={() => signIn("google")}
        className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
      >
        Sign in with Google
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Link href="/subscriptions" className="text-sm text-gray-700 hover:underline">
        My subscriptions
      </Link>
      {session.user.role === "ADMIN" && (
        <Link href="/admin" className="text-sm text-gray-700 hover:underline">
          Admin
        </Link>
      )}
      <span className="text-sm text-gray-700">
        {session.user.name ?? session.user.email}
        {session.user.role === "ADMIN" && (
          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
            Admin
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={() => signOut()}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
      >
        Sign out
      </button>
    </div>
  );
}
