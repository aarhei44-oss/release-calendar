"use server";

import { z } from "zod";
import { getProfile, updateTimezone as repoUpdateTimezone } from "@/data/profile/profileRepo";
import { requireUser } from "@/lib/authGuards";
import { withActionLogging } from "@/lib/logger";

// Intl.supportedValuesOf("timeZone") on the server is the source of truth
// for what's a valid zone (see app/profile/page.tsx, which sends the same
// list to the client) -- this just guards against a tampered request rather
// than re-deriving the full list here.
const timezoneSchema = z
  .string()
  .min(1)
  .refine((value) => Intl.supportedValuesOf("timeZone").includes(value), { message: "Unknown timezone" })
  .nullable();

export async function getMyProfile() {
  return withActionLogging("profile.getMyProfile", async () => {
    const user = await requireUser();
    return getProfile(user.id);
  });
}

export async function updateTimezone(timezone: string | null) {
  return withActionLogging("profile.updateTimezone", async () => {
    const user = await requireUser();
    const parsed = timezoneSchema.parse(timezone);
    return repoUpdateTimezone(user.id, parsed);
  });
}
