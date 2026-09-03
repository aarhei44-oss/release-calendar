import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_ADSENSE_CLIENT_ID = process.env.ADSENSE_CLIENT_ID;

beforeEach(() => {
  delete process.env.ADSENSE_CLIENT_ID;
});

afterEach(() => {
  if (ORIGINAL_ADSENSE_CLIENT_ID === undefined) delete process.env.ADSENSE_CLIENT_ID;
  else process.env.ADSENSE_CLIENT_ID = ORIGINAL_ADSENSE_CLIENT_ID;
});

describe("GET /ads.txt", () => {
  it("serves an empty body when ADSENSE_CLIENT_ID isn't configured", async () => {
    const { GET } = await import("@/app/ads.txt/route");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("serves the Google-required line, stripping the 'ca-' prefix, once configured", async () => {
    process.env.ADSENSE_CLIENT_ID = "ca-pub-1234567890123456";
    const { GET } = await import("@/app/ads.txt/route");
    const response = await GET();
    expect(await response.text()).toBe("google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0\n");
  });
});
