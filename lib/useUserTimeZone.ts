"use client";

import { useSession } from "next-auth/react";

/** The signed-in user's profile timezone override, or undefined (render in the browser's own local zone) if unset or signed out. */
export function useUserTimeZone(): string | undefined {
  const { data: session } = useSession();
  return session?.user?.timezone ?? undefined;
}
