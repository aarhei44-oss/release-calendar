import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/siteUrl";
import { prisma } from "@/lib/prisma";

// Only the pages that render the same public content for every visitor --
// no per-user dashboard/profile/subscriptions routes (see app/robots.ts).
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

  // Per-game index and per-set detail pages (app/calendar/[gameSlug] and
  // [gameSlug]/[setSlug]) -- only sets that have a slug, since older/
  // placeholder rows without one (see ProductSet.slug's schema comment)
  // have no detail page to list. Degrades to an empty list, same as
  // lastDataChange above, rather than failing the whole sitemap.
  const [enabledGames, slugs] = await Promise.all([
    prisma.tcgProfileInstall
      .findMany({ where: { enabled: true }, select: { package: { select: { slug: true } } } })
      .catch(() => []),
    prisma.productSet
      .findMany({
        where: { slug: { not: null }, archivedAt: null },
        select: { slug: true, updatedAt: true, install: { select: { package: { select: { slug: true } } } } },
      })
      .catch(() => []),
  ]);

  const gamePages: MetadataRoute.Sitemap = enabledGames.map((install) => ({
    url: `${SITE_URL}/calendar/${install.package.slug}`,
    lastModified: lastDataChange,
    changeFrequency: "daily",
    priority: 0.7,
  }));

  const setPages: MetadataRoute.Sitemap = slugs.map((set) => ({
    url: `${SITE_URL}/calendar/${set.install.package.slug}/${set.slug}`,
    lastModified: set.updatedAt,
    changeFrequency: "weekly",
    priority: 0.6,
  }));

  return [
    { url: SITE_URL, lastModified: lastDataChange, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/calendar`, lastModified: lastDataChange, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/about`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${SITE_URL}/premium`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/privacy`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${SITE_URL}/terms`, changeFrequency: "yearly", priority: 0.2 },
    ...gamePages,
    ...setPages,
  ];
}
