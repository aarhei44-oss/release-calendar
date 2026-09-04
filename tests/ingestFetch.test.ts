import { describe, expect, it, vi } from "vitest";
import { USER_AGENT, decodeValidators, encodeValidators, fetchConditional } from "@/lib/ingest/fetch";
import { tcgcsvProvider } from "@/lib/ingest/providers/tcgcsv";

/**
 * The Fetch stage's policy: conditional requests, retry rules, and the fault
 * isolation the orchestrator depends on.
 *
 * Every test injects its own `fetch`, so nothing here touches the network --
 * which is the same seam production uses (FetchContext.fetch), not a test-only
 * back door.
 *
 * Each test uses a distinct host: lib/ingest/fetch.ts serialises requests per
 * host with a minimum gap, and sharing one would make the suite pay it.
 */

function response(status: number, body = "{}", headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : body, { status, headers });
}

/** A mock fetch typed like the real one, so the recorded call's init is readable. */
type FetchMock = (url: string, init?: RequestInit) => Promise<Response>;

describe("fetchConditional: headers", () => {
  it("sends the shared User-Agent and the stored validators", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => response(200, '{"ok":true}'));
    await fetchConditional({
      url: "https://headers.example/one",
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      validators: { etag: 'W/"abc"', lastModified: "Fri, 04 Sep 2026 20:00:00 GMT" },
    });

    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(USER_AGENT);
    expect(headers["User-Agent"]).toContain("releasewatcher.com");
    expect(headers.Accept).toBe("application/json");
    expect(headers["If-None-Match"]).toBe('W/"abc"');
    expect(headers["If-Modified-Since"]).toBe("Fri, 04 Sep 2026 20:00:00 GMT");
  });

  it("sends no conditional headers on a first fetch", async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => response(200));
    await fetchConditional({ url: "https://first.example/one", fetch: fetchImpl as unknown as typeof globalThis.fetch });
    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["If-None-Match"]).toBeUndefined();
    expect(headers["If-Modified-Since"]).toBeUndefined();
  });
});

describe("fetchConditional: statuses", () => {
  it("reports 304 as not-modified rather than an empty success", async () => {
    const fetchImpl = vi.fn(async () => response(304));
    const result = await fetchConditional({
      url: "https://cached.example/one",
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
      validators: { etag: '"x"' },
    });
    expect(result).toEqual({ kind: "not-modified" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns the body and the response's validators on 200", async () => {
    const fetchImpl = vi.fn(async () =>
      response(200, '{"a":1}', { etag: '"v2"', "last-modified": "Fri, 04 Sep 2026 20:00:00 GMT" }),
    );
    const result = await fetchConditional({
      url: "https://fresh.example/one",
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });
    expect(result).toEqual({
      kind: "ok",
      body: '{"a":1}',
      validators: { etag: '"v2"', lastModified: "Fri, 04 Sep 2026 20:00:00 GMT" },
    });
  });

  it("never retries a 4xx", async () => {
    // A 4xx is the server saying the request itself is wrong. Repeating it is
    // pointless and is the fastest way to earn a block.
    const fetchImpl = vi.fn(async () => response(403));
    await expect(
      fetchConditional({ url: "https://forbidden.example/one", fetch: fetchImpl as unknown as typeof globalThis.fetch }),
    ).rejects.toThrow(/403/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx once and succeeds", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => (++call === 1 ? response(503) : response(200, '{"b":2}')));
    const result = await fetchConditional({
      url: "https://flaky.example/one",
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });
    expect(result).toMatchObject({ kind: "ok", body: '{"b":2}' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("retries a transport failure once and then gives up", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(
      fetchConditional({ url: "https://down.example/one", fetch: fetchImpl as unknown as typeof globalThis.fetch }),
    ).rejects.toThrow(/ECONNRESET/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 10_000);
});

describe("validator encoding", () => {
  it("stores a bare ETag as a bare string", () => {
    expect(encodeValidators({ etag: 'W/"abc"' })).toBe('W/"abc"');
  });

  it("round-trips an ETag plus a Last-Modified", () => {
    const encoded = encodeValidators({ etag: '"a"', lastModified: "Fri, 04 Sep 2026 20:00:00 GMT" });
    expect(decodeValidators(encoded)).toEqual({ etag: '"a"', lastModified: "Fri, 04 Sep 2026 20:00:00 GMT" });
  });

  it("round-trips a Last-Modified with no ETag, as YGOPRODeck sends", () => {
    const encoded = encodeValidators({ lastModified: "Fri, 04 Sep 2026 21:16:21 GMT" });
    expect(decodeValidators(encoded)).toEqual({ etag: null, lastModified: "Fri, 04 Sep 2026 21:16:21 GMT" });
  });

  it("reads a column written before this encoding existed", () => {
    expect(decodeValidators('W/"legacy"')).toEqual({ etag: 'W/"legacy"' });
  });

  it("stores nothing when there is nothing to store", () => {
    expect(encodeValidators({})).toBeNull();
    expect(decodeValidators(null)).toEqual({});
  });
});

describe("provider fault isolation", () => {
  it("records a failed fetch as a FAILED payload instead of throwing", async () => {
    // The orchestrator's contract is that one provider's outage costs that
    // provider and nothing else; returning the failure keeps the error message
    // and lets the other providers' candidates be applied.
    const payload = await tcgcsvProvider.fetch({
      scanRunId: "run-1",
      fetch: (async () => {
        throw new Error("tcgcsv is down");
      }) as unknown as typeof globalThis.fetch,
      now: new Date("2026-09-04T21:00:00Z"),
    });

    expect(payload.status).toBe("FAILED");
    expect(payload.error).toContain("tcgcsv is down");
    expect(payload.body.length).toBe(0);
    expect(payload.providerKey).toBe("tcgcsv");
    expect(payload.scanRunId).toBe("run-1");
  }, 20_000);
});
