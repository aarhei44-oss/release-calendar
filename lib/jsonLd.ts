/**
 * Safe to drop into a `<script type="application/ld+json">` via
 * dangerouslySetInnerHTML. Plain JSON.stringify doesn't escape "<", so a
 * string value containing "</script>" -- e.g. a ProductSet.name pulled in
 * by the ingest pipeline from an external source -- would prematurely close
 * the surrounding script tag and dump the rest of the JSON as visible page
 * markup.
 */
export function serializeJsonLd(data: object): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
