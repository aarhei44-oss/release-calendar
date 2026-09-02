import { describe, expect, it } from "vitest";
import { htmlTableAdapter } from "@/lib/crawler/adapters/htmlTableAdapter";
import type { RawFetchResult, SourceConfig } from "@/lib/crawler/adapters/types";

function raw(html: string): RawFetchResult {
  return { url: "https://example.com/sets", status: 200, html, fetchedAt: new Date() };
}

function config(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return { url: "https://example.com/sets", tier: "COMMUNITY", parser: "html-table", ...overrides };
}

describe("htmlTableAdapter.parse", () => {
  it("extracts rows from a wikitable-style table with Name/Release date columns", () => {
    const html = `
      <table class="wikitable">
        <tr><th>Set No.</th><th>Name</th><th>Release date</th><th>Details</th></tr>
        <tr><td>1</td><td>Base Set</td><td>January 9, 1999</td><td>...</td></tr>
        <tr><td>2</td><td>Jungle</td><td>June 16, 1999</td><td>...</td></tr>
      </table>
    `;
    const candidates = htmlTableAdapter.parse(raw(html), config());
    expect(candidates).toHaveLength(2);
    expect(candidates[0].productSetName).toBe("Base Set");
    expect(candidates[0].dateType).toBe("EXACT");
    expect(candidates[1].productSetName).toBe("Jungle");
  });

  it("finds the release-date column even when other date-ish columns exist first (e.g. pre-release)", () => {
    const html = `
      <table class="wikitable">
        <tr><th>Set</th><th>Pre-release date</th><th>Release date</th></tr>
        <tr><td>Kaladesh</td><td>September 24, 2016</td><td>September 30, 2016</td></tr>
      </table>
    `;
    const candidates = htmlTableAdapter.parse(raw(html), config());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].dateType).toBe("EXACT");
    if (candidates[0].dateType === "EXACT") {
      expect(candidates[0].dateExact.getUTCDate()).toBe(30);
    }
  });

  it("processes multiple tables on the same page (per-generation Wikipedia layout)", () => {
    const html = `
      <table class="wikitable">
        <tr><th>Name</th><th>Release date</th></tr>
        <tr><td>XY</td><td>February 5, 2014</td></tr>
      </table>
      <table class="wikitable">
        <tr><th>Name</th><th>Release date</th></tr>
        <tr><td>Sun & Moon</td><td>February 3, 2017</td></tr>
      </table>
    `;
    const candidates = htmlTableAdapter.parse(raw(html), config());
    expect(candidates.map((c) => c.productSetName)).toEqual(["XY", "Sun & Moon"]);
  });

  it("skips tables that have no matching name/date columns (e.g. an unrelated layout table)", () => {
    const html = `
      <table><tr><th>Foo</th><th>Bar</th></tr><tr><td>x</td><td>y</td></tr></table>
      <table class="wikitable"><tr><th>Name</th><th>Release date</th></tr><tr><td>Real Set</td><td>May 9, 2012</td></tr></table>
    `;
    const candidates = htmlTableAdapter.parse(raw(html), config());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].productSetName).toBe("Real Set");
  });

  it("strips Wikipedia-style footnote markers from cell text", () => {
    const html = `
      <table class="wikitable">
        <tr><th>Name</th><th>Release date</th></tr>
        <tr><td>Base Set[1]</td><td>January 9, 1999[2]</td></tr>
      </table>
    `;
    const candidates = htmlTableAdapter.parse(raw(html), config());
    expect(candidates[0].productSetName).toBe("Base Set");
    expect(candidates[0].dateType).toBe("EXACT");
  });

  it("falls back to TBD for unparseable date text without dropping the row", () => {
    const html = `
      <table class="wikitable">
        <tr><th>Name</th><th>Release date</th></tr>
        <tr><td>Mystery Set</td><td>Coming soon</td></tr>
      </table>
    `;
    const candidates = htmlTableAdapter.parse(raw(html), config());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].dateType).toBe("TBD");
  });

  it("applies codePrefix/eventType/region options and derives a stable slug code", () => {
    const html = `
      <table class="wikitable">
        <tr><th>Name</th><th>Release date</th></tr>
        <tr><td>Sun & Moon</td><td>February 3, 2017</td></tr>
      </table>
    `;
    const candidates = htmlTableAdapter.parse(
      raw(html),
      config({ options: { codePrefix: "PKM", eventType: "SHELF", region: "JP" } }),
    );
    expect(candidates[0].productSetCode).toBe("PKM-SUN-MOON");
    expect(candidates[0].eventType).toBe("SHELF");
    expect(candidates[0].region).toBe("JP");
  });

  it("returns an empty array when the page has no tables at all", () => {
    expect(htmlTableAdapter.parse(raw("<html><body><p>no tables here</p></body></html>"), config())).toEqual([]);
  });
});
