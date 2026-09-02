import { htmlTableAdapter } from "./htmlTableAdapter";
import type { ParserAdapter, RawFetchResult, SourceConfig } from "./types";

/**
 * fetch() returns static, checked-in HTML instead of doing network I/O, so
 * the full scan orchestration can be exercised deterministically in tests
 * (Phase 6 step 9) without depending on a live external site. Parsing
 * reuses htmlTableAdapter's real column-detection logic, since the point
 * is to test the orchestration pipeline, not a second parser implementation.
 */
export const FIXTURE_HTML = `
<html><body>
<table class="wikitable">
  <tr><th>Set No.</th><th>Name</th><th>Release date</th><th>Details</th></tr>
  <tr><td>1</td><td>Fixture Booster One</td><td>March 15, 2026</td><td>Test row</td></tr>
  <tr><td>2</td><td>Fixture Booster Two</td><td>April 2026</td><td>Month-only date</td></tr>
  <tr><td>3</td><td>Fixture Booster Three</td><td>TBA</td><td>Unparseable date</td></tr>
</table>
</body></html>
`;

export function createFixtureAdapter(html: string = FIXTURE_HTML): ParserAdapter {
  return {
    key: "fixture",
    async fetch(config: SourceConfig): Promise<RawFetchResult> {
      return { url: config.url, status: 200, html, fetchedAt: new Date() };
    },
    parse(raw: RawFetchResult, config: SourceConfig) {
      return htmlTableAdapter.parse(raw, config);
    },
  };
}

export const fixtureAdapter = createFixtureAdapter();
