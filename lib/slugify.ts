/**
 * `name -> kebab-case`, for ProductSet.slug specifically. Deliberately not
 * shared with the two narrower existing ad hoc slugifiers --
 * app/api/events/[eventId]/ics/route.ts's (an ICS download filename) and
 * lib/ingest/providers/playriftbound.ts's slugifyName (a SetIdentity
 * external id) -- changing either risks an unrelated behavior change for a
 * purpose this one doesn't share.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents (e.g. "Pokémon" -> "pokemon")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
