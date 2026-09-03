"use client";

import { signIn } from "next-auth/react";

export function SignInPrompt({
  message = "Sign in to subscribe to your favorite TCGs and track upcoming releases.",
}: {
  message?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 p-12 text-center">
      <p className="text-gray-600">{message}</p>
      <button
        type="button"
        onClick={() => signIn("google")}
        className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
      >
        Sign in with Google
      </button>
    </div>
  );
}
