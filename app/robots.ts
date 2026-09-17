import type { MetadataRoute } from "next";

const baseUrl = process.env.NEXTAUTH_URL ?? "https://releasewatcher.com";

// Signed-in-only screens (dashboard, profile, subscriptions, admin) have
// nothing for a crawler to index and shouldn't be offered as search results,
// so they're excluded here rather than left for Googlebot to discover and
// skip on its own.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/dashboard", "/profile", "/subscriptions", "/admin", "/api/"],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
