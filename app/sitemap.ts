import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/siteUrl";
import { prisma } from "@/lib/prisma";

// Only the pages that render the same public content for every visitor --
// no per-user dashboard/profile/subscriptions routes (see app/robots.ts),
// and no per-entity pages because none exist yet (ReleaseEvent/ProductSet
// have no slugs or dedicated routes -- see the calendar's eventId query
// param, which never server-renders distinct content per event).
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Approximates "when did the public content on / and /calendar last
  // change" -- there's no lastModified column on ReleaseEvent itself, but a
  // scan run touching any event's lastSeenAt is the closest real signal this
  // schema has, and degrades to "now" rather than failing the whole sitemap
  // if the database is briefly unreachable.
  const lastDataChange = await prisma.releaseEvent
    .aggregate({ _max: { lastSeenAt: true } })
    .then((result) => result._max.lastSeenAt ?? new Date())
    .catch(() => new Date());

  return [
    { url: SITE_URL, lastModified: lastDataChange, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/calendar`, lastModified: lastDataChange, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/about`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${SITE_URL}/premium`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/privacy`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${SITE_URL}/terms`, changeFrequency: "yearly", priority: 0.2 },
  ];
}
