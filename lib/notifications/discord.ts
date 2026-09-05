import { describeChange, type ScanChange } from "./types";

const ALLOWED_HOSTS = new Set(["discord.com", "discordapp.com"]);

/**
 * A user-supplied webhook URL is something this server POSTs to on its own
 * behalf (during a scan, with no request from that user in flight) -- an
 * unrestricted URL here would make this an open SSRF relay onto whatever
 * internal network the app runs on. Restricting to Discord's own webhook
 * host+path is the actual feature (a Discord webhook), not just a nice-to-
 * have, so this is enforced both here (defense in depth) and at save time
 * in app/profile/actions.ts.
 */
export function isValidDiscordWebhookUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname) && url.pathname.startsWith("/api/webhooks/");
}

function contentFor(changes: ScanChange[]): string {
  const lines = changes.map((change) => `**${change.gameName}** - ${change.productSetName}: ${describeChange(change)}`);
  return lines.join("\n").slice(0, 2000); // Discord's message content limit.
}

export async function sendDiscordAlert(webhookUrl: string, changes: ScanChange[]): Promise<void> {
  if (changes.length === 0) return;
  if (!isValidDiscordWebhookUrl(webhookUrl)) return;

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: contentFor(changes) }),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook responded with ${response.status}`);
  }
}

/**
 * An operational alarm to an admin's Discord webhook (lib/ingest/freshness.ts).
 *
 * Deliberately reuses sendDiscordAlert's transport shape and, crucially, the
 * same isValidDiscordWebhookUrl check: the URL is still user-supplied and this
 * is still the server POSTing to it unprompted, so the SSRF argument in that
 * function's comment applies here word for word.
 */
export async function sendAdminAlarmDiscord(webhookUrl: string, content: string): Promise<void> {
  if (!isValidDiscordWebhookUrl(webhookUrl)) return;

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 2000) }), // Discord's message content limit.
  });

  if (!response.ok) {
    throw new Error(`Discord webhook responded with ${response.status}`);
  }
}
