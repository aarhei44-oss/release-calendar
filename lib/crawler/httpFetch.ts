const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const USER_AGENT = "release-watcher-crawler/1.0 (self-hosted TCG calendar)";

/**
 * Fetches a URL with a hard timeout and a single retry on failure (network
 * error/timeout, or a 5xx response), after a short delay. Shared by every
 * crawler pass that fetches an external page (source scanning, image
 * enrichment) so the timeout/User-Agent/retry policy lives in one place
 * instead of being copied at each call site.
 *
 * Without the retry, a single transient blip (a timeout, a momentary 503)
 * skips that source entirely until the next scan -- daily, for the
 * scheduled crawl. Never retries a 4xx: that's the site telling us the
 * request itself is wrong, not that it's temporarily unavailable.
 */
export async function fetchWithRetry(
  url: string,
  options: { timeoutMs?: number; retryDelayMs?: number } = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT },
      });
      if (response.ok || response.status < 500 || attempt === 2) return response;
    } catch (error) {
      if (attempt === 2) throw error;
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  throw new Error("unreachable");
}
