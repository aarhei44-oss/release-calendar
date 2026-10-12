/**
 * Canonical base URL -- shared by app/robots.ts, app/sitemap.ts, the root
 * layout's metadataBase, and anywhere else that needs to build an absolute
 * URL back to this site (e.g. JSON-LD). NEXTAUTH_URL already carries this
 * same per-deployment value for auth callbacks, so it's reused here rather
 * than introducing a second env var that could drift from it.
 */
export const SITE_URL = process.env.NEXTAUTH_URL ?? "https://releasewatcher.com";
