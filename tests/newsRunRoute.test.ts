import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: vi.fn() };
});

const runNewsFetch = vi.fn();
vi.mock("@/lib/news/fetchFeeds", () => ({
  runNewsFetch: (...args: unknown[]) => runNewsFetch(...args),
}));

import { getServerSession } from "next-auth";
import { POST } from "@/app/api/news/run/route";

const mockGetServerSession = vi.mocked(getServerSession);

function sessionFor(role: "USER" | "ADMIN") {
  return {
    user: { id: "user-1", role, active: true },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

function request(options: { auth?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.auth) headers.authorization = options.auth;
  return new Request("http://localhost/api/news/run", { method: "POST", headers });
}

describe("POST /api/news/run", () => {
  const originalToken = process.env.NEWS_TRIGGER_TOKEN;

  beforeEach(() => {
    runNewsFetch.mockReset();
    runNewsFetch.mockResolvedValue({ sourcesFetched: 6 });
    mockGetServerSession.mockReset();
    mockGetServerSession.mockResolvedValue(null);
    process.env.NEWS_TRIGGER_TOKEN = "correct-token";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.NEWS_TRIGGER_TOKEN;
    else process.env.NEWS_TRIGGER_TOKEN = originalToken;
  });

  it("rejects a request with no bearer token and no session", async () => {
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(runNewsFetch).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong bearer token", async () => {
    const response = await POST(request({ auth: "Bearer wrong-token" }));
    expect(response.status).toBe(401);
    expect(runNewsFetch).not.toHaveBeenCalled();
  });

  it("fails closed when NEWS_TRIGGER_TOKEN is unset, even with a bearer token presented", async () => {
    delete process.env.NEWS_TRIGGER_TOKEN;
    const response = await POST(request({ auth: "Bearer anything" }));
    expect(response.status).toBe(401);
    expect(runNewsFetch).not.toHaveBeenCalled();
  });

  it("rejects a signed-in non-admin session with no bearer token", async () => {
    mockGetServerSession.mockResolvedValue(sessionFor("USER"));
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(runNewsFetch).not.toHaveBeenCalled();
  });

  it("accepts the correct bearer token and starts a fetch pass", async () => {
    const response = await POST(request({ auth: "Bearer correct-token" }));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toEqual({ status: "accepted" });
    expect(runNewsFetch).toHaveBeenCalledTimes(1);
  });

  it("accepts an admin session with no bearer token", async () => {
    mockGetServerSession.mockResolvedValue(sessionFor("ADMIN"));
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(runNewsFetch).toHaveBeenCalledTimes(1);
  });

  it("does not let a failure in the background run reject the request", async () => {
    let rejectRun: (error: Error) => void = () => {};
    runNewsFetch.mockReturnValue(
      new Promise((_, reject) => {
        rejectRun = reject;
      }),
    );

    const response = await POST(request({ auth: "Bearer correct-token" }));
    expect(response.status).toBe(202);

    rejectRun(new Error("feed blew up"));
    // Let the attached .catch on the background promise run before the test exits.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
