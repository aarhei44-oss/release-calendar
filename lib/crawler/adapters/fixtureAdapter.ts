import { htmlTableAdapter } from "./htmlTableAdapter";
import type { ParserAdapter, RawFetchResult, SourceConfig } from "./types";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Computed relative to "now" (module load time, i.e. whenever tests
// actually run) rather than a fixed calendar date, so this fixture never
// silently drifts into an unintended state as real time passes -- a fixed
// past date would eventually age past the retention pass's 30-day cutoff
// (lib/crawler/retention.ts) and get deleted before a test can inspect it,
// exactly as happened with the old hardcoded "March 15, 2026".
const EXACT_DATE_IN_PAST = new Date();
EXACT_DATE_IN_PAST.setDate(EXACT_DATE_IN_PAST.getDate() - 7);
const EXACT_DATE_ISO = EXACT_DATE_IN_PAST.toISOString().slice(0, 10);

const WINDOW_DATE_IN_FUTURE = new Date();
WINDOW_DATE_IN_FUTURE.setMonth(WINDOW_DATE_IN_FUTURE.getMonth() + 2);
const WINDOW_MONTH_YEAR = `${MONTH_NAMES[WINDOW_DATE_IN_FUTURE.getMonth()]} ${WINDOW_DATE_IN_FUTURE.getFullYear()}`;

/**
 * "Fixture Booster One" is 7 days in the past -- old enough for the release
 * lifecycle pass to flip it to RELEASED, but well inside the 30-day
 * retention window (see tests/crawlerOrchestrate.test.ts's assertion on
 * this). "Fixture Booster Two" is 2 months out -- there's no assertion
 * relying on it being past-due, so it's future-dated to stay clear of
 * retention entirely.
 */
export const FIXTURE_HTML = `
<html><body>
<table class="wikitable">
  <tr><th>Set No.</th><th>Name</th><th>Release date</th><th>Details</th></tr>
  <tr><td>1</td><td>Fixture Booster One</td><td>${EXACT_DATE_ISO}</td><td>Test row</td></tr>
  <tr><td>2</td><td>Fixture Booster Two</td><td>${WINDOW_MONTH_YEAR}</td><td>Month-only date</td></tr>
  <tr><td>3</td><td>Fixture Booster Three</td><td>TBA</td><td>Unparseable date</td></tr>
</table>
</body></html>
`;

export function createFixtureAdapter(html: string = FIXTURE_HTML, key: string = "fixture"): ParserAdapter {
  return {
    key,
    async fetch(config: SourceConfig): Promise<RawFetchResult> {
      return { url: config.url, status: 200, html, fetchedAt: new Date() };
    },
    parse(raw: RawFetchResult, config: SourceConfig) {
      return htmlTableAdapter.parse(raw, config);
    },
  };
}

export const fixtureAdapter = createFixtureAdapter();
