import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidDiscordWebhookUrl, sendDiscordAlert } from "@/lib/notifications/discord";
import type { ScanChange } from "@/lib/notifications/types";

const CHANGE: ScanChange = {
  installId: "install-1",
  eventId: "event-1",
  gameName: "Magic: The Gathering",
  productSetName: "Foundations",
  status: "CONFIRMED",
  kind: "status_changed",
  previousStatus: "ANNOUNCED",
};

describe("isValidDiscordWebhookUrl", () => {
  it("accepts a real Discord webhook URL", () => {
    expect(isValidDiscordWebhookUrl("https://discord.com/api/webhooks/123456/abcDEF")).toBe(true);
  });

  it("accepts the legacy discordapp.com host", () => {
    expect(isValidDiscordWebhookUrl("https://discordapp.com/api/webhooks/123456/abcDEF")).toBe(true);
  });

  it("rejects a non-Discord host (SSRF guard)", () => {
    expect(isValidDiscordWebhookUrl("https://evil.example.com/api/webhooks/123/abc")).toBe(false);
  });

  it("rejects a Discord host with a different path", () => {
    expect(isValidDiscordWebhookUrl("https://discord.com/some/other/path")).toBe(false);
  });

  it("rejects a non-https scheme", () => {
    expect(isValidDiscordWebhookUrl("http://discord.com/api/webhooks/123/abc")).toBe(false);
  });

  it("rejects an internal-looking host smuggled via the Discord path", () => {
    expect(isValidDiscordWebhookUrl("https://169.254.169.254/api/webhooks/123/abc")).toBe(false);
  });

  it("rejects garbage input", () => {
    expect(isValidDiscordWebhookUrl("not a url")).toBe(false);
  });
});

describe("sendDiscordAlert", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing for an empty change list", async () => {
    await sendDiscordAlert("https://discord.com/api/webhooks/1/a", []);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("silently does nothing for an invalid webhook URL instead of posting to it", async () => {
    await sendDiscordAlert("https://evil.example.com/steal", [CHANGE]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs a JSON payload summarizing the changes to a valid webhook URL", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });

    await sendDiscordAlert("https://discord.com/api/webhooks/1/a", [CHANGE]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://discord.com/api/webhooks/1/a");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.content).toContain("Magic: The Gathering");
    expect(body.content).toContain("Foundations");
  });

  it("throws when Discord responds with a non-ok status, so the caller can log it", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(sendDiscordAlert("https://discord.com/api/webhooks/1/a", [CHANGE])).rejects.toThrow();
  });
});
