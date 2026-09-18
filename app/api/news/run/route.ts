import { timingSafeEqual } from "node:crypto";
import { requireAdmin } from "@/lib/authGuards";
import { runNewsFetch } from "@/lib/news/fetchFeeds";
import { logEvent } from "@/lib/logger";

/**
 * `POST /api/news/run` -- the production trigger for the news-feed fetch
 * pipeline (lib/news/fetchFeeds.ts).
 *
 * Structural copy of app/api/ingest/run/route.ts's own auth/trigger shape --
 * see that file's doc comment for why an external cron hitting an HTTP
 * endpoint is preferred over an in-process scheduler. This pipeline has no
 * JobLock/ScanRun of its own (see fetchFeeds.ts's doc comment on why it's
 * deliberately simpler than ingest), so there's no "already running" case to
 * report here -- a second call while one is in flight just runs a second
 * pass over the same sources, each upserting by URL.
 *
 * Uses its own NEWS_TRIGGER_TOKEN rather than reusing INGEST_TRIGGER_TOKEN --
 * least-privilege, matching this repo's existing pattern of scoping secrets
 * per purpose (e.g. the Discord webhook's host/path restriction).
 */

// Node runtime, not edge: node:crypto's timingSafeEqual and Prisma are both
// Node-only.
export const runtime = "nodejs";

// Nothing here is cacheable, and a cached POST would be a trigger that
// silently stops triggering.
export const dynamic = "force-dynamic";

/** Constant-time string comparison -- see app/api/ingest/run/route.ts's own tokensMatch for the length-check caveat. */
function tokensMatch(presented: string, configured: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(configured, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type AuthOutcome = { ok: true; via: "token" | "admin"; userId?: string } | { ok: false; reason: string };

/**
 * Two accepted callers, checked in that order -- same as /api/ingest/run.
 * Fails closed when NEWS_TRIGGER_TOKEN is unset: an unset secret is a
 * misconfiguration, not a decision to run without auth.
 */
async function authorize(request: Request): Promise<AuthOutcome> {
  const header = request.headers.get("authorization");
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

  if (presented !== null) {
    const configured = process.env.NEWS_TRIGGER_TOKEN;
    if (!configured) return { ok: false, reason: "NEWS_TRIGGER_TOKEN is not configured" };
    if (!tokensMatch(presented, configured)) return { ok: false, reason: "bearer token does not match" };
    return { ok: true, via: "token" };
  }

  try {
    const admin = await requireAdmin();
    return { ok: true, via: "admin", userId: admin.id };
  } catch {
    return { ok: false, reason: "no bearer token and no admin session" };
  }
}

export async function POST(request: Request) {
  const auth = await authorize(request);
  if (!auth.ok) {
    logEvent({ action: "news.trigger", outcome: "denied", reason: auth.reason });
    // One undifferentiated 401, same reasoning as /api/ingest/run: a caller
    // who guessed wrong should not learn why.
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Fire-and-forget, mirroring /api/ingest/run: a fetch pass across every
  // enabled source can outlast a cron client's or reverse proxy's patience.
  // Each source records its own outcome (lastFetchedAt/lastEtag/lastError),
  // which the admin System tab reads -- nothing is lost by not waiting.
  runNewsFetch()
    .then((result) => {
      logEvent({
        action: "news.trigger.background",
        outcome: "success",
        via: auth.via,
        sourcesFetched: result.sourcesFetched,
      });
    })
    .catch((error) => {
      logEvent({
        action: "news.trigger.background",
        outcome: "error",
        via: auth.via,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  logEvent({ action: "news.trigger", outcome: "accepted", via: auth.via, userId: auth.userId });

  return Response.json({ status: "accepted" }, { status: 202 });
}
