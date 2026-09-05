import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: vi.fn() };
});

const startIngest = vi.fn();
vi.mock("@/lib/ingest/orchestrate", () => ({
  startIngest: (...args: unknown[]) => startIngest(...args),
}));

import { getServerSession } from "next-auth";
import { POST } from "@/app/api/ingest/run/route";

const mockGetServerSession = vi.mocked(getServerSession);

function sessionFor(role: "USER" | "ADMIN") {
  return {
    user: { id: "user-1", role, active: true },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

function request(options: { auth?: string; body?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.auth) headers.authorization = options.auth;
  return new Request("http://localhost/api/ingest/run", {
    method: "POST",
    headers,
    body: options.body,
  });
}

describe("POST /api/ingest/run", () => {
  const originalToken = process.env.INGEST_TRIGGER_TOKEN;

  beforeEach(() => {
    startIngest.mockReset();
    startIngest.mockResolvedValue({ started: true, scanRunId: "run-1", completed: Promise.resolve() });
    mockGetServerSession.mockReset();
    mockGetServerSession.mockResolvedValue(null);
    process.env.INGEST_TRIGGER_TOKEN = "correct-token";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.INGEST_TRIGGER_TOKEN;
    else process.env.INGEST_TRIGGER_TOKEN = originalToken;
  });

  it("rejects a request with no bearer token and no session", async () => {
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(startIngest).not.toHaveBeenCalled();
  });

  it("rejects a request with the wrong bearer token", async () => {
    const response = await POST(request({ auth: "Bearer wrong-token" }));
    expect(response.status).toBe(401);
    expect(startIngest).not.toHaveBeenCalled();
  });

  it("fails closed when INGEST_TRIGGER_TOKEN is unset, even with a bearer token presented", async () => {
    delete process.env.INGEST_TRIGGER_TOKEN;
    const response = await POST(request({ auth: "Bearer anything" }));
    expect(response.status).toBe(401);
    expect(startIngest).not.toHaveBeenCalled();
  });

  it("rejects a signed-in non-admin session with no bearer token", async () => {
    mockGetServerSession.mockResolvedValue(sessionFor("USER"));
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(startIngest).not.toHaveBeenCalled();
  });

  it("accepts the correct bearer token and starts a scan scoped to ALL", async () => {
    const response = await POST(request({ auth: "Bearer correct-token" }));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toEqual({ status: "accepted", scanRunId: "run-1" });
    expect(startIngest).toHaveBeenCalledWith({ scope: { scopeType: "ALL" }, trigger: "SCHEDULED" });
  });

  it("accepts an admin session with no bearer token, triggering a MANUAL run", async () => {
    mockGetServerSession.mockResolvedValue(sessionFor("ADMIN"));
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(startIngest).toHaveBeenCalledWith({ scope: { scopeType: "ALL" }, trigger: "MANUAL" });
  });

  it("scopes to a single install when installId is given in the body", async () => {
    const response = await POST(request({ auth: "Bearer correct-token", body: JSON.stringify({ installId: "install-1" }) }));
    expect(response.status).toBe(202);
    expect(startIngest).toHaveBeenCalledWith({
      scope: { scopeType: "INSTALL", scopeId: "install-1" },
      trigger: "SCHEDULED",
    });
  });

  it("rejects a body of the wrong shape with 400", async () => {
    const response = await POST(request({ auth: "Bearer correct-token", body: JSON.stringify({ installId: 123 }) }));
    expect(response.status).toBe(400);
    expect(startIngest).not.toHaveBeenCalled();
  });

  it("treats an empty body as the normal no-scope case rather than an error", async () => {
    const response = await POST(request({ auth: "Bearer correct-token", body: "" }));
    expect(response.status).toBe(202);
  });

  it("returns 409 when a scan is already running for the scope", async () => {
    startIngest.mockResolvedValue({ started: false, reason: "a scan is already running for this scope" });
    const response = await POST(request({ auth: "Bearer correct-token" }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.status).toBe("already-running");
  });

  it("does not let a failure in the background run reject the request", async () => {
    let rejectCompleted: (error: Error) => void = () => {};
    const completed = new Promise<never>((_, reject) => {
      rejectCompleted = reject;
    });
    startIngest.mockResolvedValue({ started: true, scanRunId: "run-2", completed });

    const response = await POST(request({ auth: "Bearer correct-token" }));
    expect(response.status).toBe(202);

    rejectCompleted(new Error("provider blew up"));
    // Let the attached .catch on the background promise run before the test exits.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
