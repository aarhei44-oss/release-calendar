import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/siteUrl";

// Signed-in-only screens (dashboard, profile, subscriptions, admin) have
// nothing for a crawler to index and shouldn't be offered as search results,
// so they're excluded here rather than left for Googlebot to discover and
// skip on its own. /news joins them for the same reason even though it's not
// auth-gated at the route level: an anonymous crawler only ever sees that
// page's sign-in/upgrade prompt (see app/news/page.tsx), never the feed.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/dashboard", "/profile", "/subscriptions", "/admin", "/news", "/api/"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
