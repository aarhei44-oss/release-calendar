import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { requireAdmin } from "@/lib/authGuards";
import { startIngest } from "@/lib/ingest/orchestrate";
import { logEvent } from "@/lib/logger";

/**
 * `POST /api/ingest/run` -- the production trigger for the v2 ingest pipeline.
 *
 * This exists to replace the failure mode of the in-process scheduler
 * (lib/crawler/scheduler.ts): a `setTimeout` living inside the Next.js process
 * means a deploy or a crash near midnight silently skips the night, and nobody
 * finds out until the calendar is a day stale. An external cron calling an
 * HTTP endpoint has the opposite property -- the scheduler outlives the app,
 * and a failed call is a non-2xx an operator's cron mailer can shout about.
 *
 * It also replaces the current way of running a scan against production by
 * hand, which is tarring the source tree, scp-ing it to the host and starting
 * a one-off container.
 *
 * Note what this is *not*: it does not touch v1. lib/crawler's scheduler is
 * still the live pipeline and still runs on its own timer; this endpoint drives
 * lib/ingest only. See the comment on startCrawlerScheduler.
 */

// Node runtime, not edge: node:crypto's timingSafeEqual, Prisma and the
// pipeline's zlib payload packing are all Node-only.
export const runtime = "nodejs";

// The body is small and per-request; nothing here is cacheable, and a cached
// POST would be a trigger that silently stops triggering.
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    /** Narrow the run to a single TcgProfileInstall; omitted means every enabled install. */
    installId: z.string().min(1).optional(),
  })
  .optional();

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on unequal-length buffers, so the length check has
 * to happen first -- and that check is inherently not constant time. That is
 * accepted and standard: it leaks the *length* of the configured token, which
 * is not a secret worth protecting, while the byte-by-byte comparison that
 * would otherwise leak the token's contents one character at a time stays
 * constant time.
 */
function tokensMatch(presented: string, configured: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(configured, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type AuthOutcome = { ok: true; via: "token" | "admin"; userId?: string } | { ok: false; reason: string };

/**
 * Two accepted callers, checked in that order.
 *
 * The bearer token is the one that matters: cron has no session and no cookie
 * jar. The admin session is accepted as well purely so the same endpoint can
 * be exercised from a signed-in browser (and from the System tab) without
 * handing the browser the shared secret.
 *
 * Fails closed when INGEST_TRIGGER_TOKEN is unset. An unset secret is a
 * misconfiguration, not a decision to run without auth, and the difference
 * between those two readings is an open "run a scan" endpoint on a public
 * host.
 */
async function authorize(request: Request): Promise<AuthOutcome> {
  const header = request.headers.get("authorization");
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

  if (presented !== null) {
    const configured = process.env.INGEST_TRIGGER_TOKEN;
    if (!configured) return { ok: false, reason: "INGEST_TRIGGER_TOKEN is not configured" };
    if (!tokensMatch(presented, configured)) return { ok: false, reason: "bearer token does not match" };
    return { ok: true, via: "token" };
  }

  // No bearer header at all: fall through to the session path, so a browser
  // request from an admin works. requireAdmin throws for everyone else.
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
    logEvent({ action: "ingest.trigger", outcome: "denied", reason: auth.reason });
    // Deliberately one undifferentiated 401 with no detail in the body: a
    // caller who guessed wrong should not learn whether the secret is unset,
    // the wrong length, or simply wrong.
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let installId: string | undefined;
  try {
    // An empty body is the normal cron case, so a failed JSON parse is not an
    // error -- only a body that parses and is the wrong shape is.
    const raw = await request.text();
    installId = raw.trim() ? bodySchema.parse(JSON.parse(raw))?.installId : undefined;
  } catch (error) {
    logEvent({
      action: "ingest.trigger",
      outcome: "error",
      via: auth.via,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const scope = installId
    ? ({ scopeType: "INSTALL", scopeId: installId } as const)
    : ({ scopeType: "ALL" } as const);

  // startIngest takes the shared "crawler" JobLock and writes the ScanRun row
  // before returning, so a second concurrent call is refused here rather than
  // racing a parallel scan through the same tables. Both v1 and v2 contend for
  // that one lock -- see orchestrate.ts's JOB_NAME.
  const started = await startIngest({ scope, trigger: auth.via === "admin" ? "MANUAL" : "SCHEDULED" });

  if (!started.started) {
    logEvent({ action: "ingest.trigger", outcome: "skipped", via: auth.via, reason: started.reason });
    return Response.json({ status: "already-running", reason: started.reason }, { status: 409 });
  }

  // Fire-and-forget from here, mirroring data/admin/adminRepo.ts's
  // triggerRescan: a full run is tens of seconds, which is longer than a cron
  // client (curl's default is generous but systemd timers and hosted cron
  // services are not) or a reverse proxy will hold the connection. The run
  // logs its own outcome and writes its ScanRun/ProviderRun rows, which the
  // admin System tab polls, so nothing is lost by not waiting.
  //
  // The catch is not optional: startIngest deliberately does not attach one,
  // so dropping it here would turn a failed run into an unhandled rejection.
  started.completed.catch((error) => {
    logEvent({
      action: "ingest.trigger.background",
      scanRunId: started.scanRunId,
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  });

  logEvent({
    action: "ingest.trigger",
    outcome: "accepted",
    via: auth.via,
    userId: auth.userId,
    scanRunId: started.scanRunId,
    scopeType: scope.scopeType,
  });

  return Response.json({ status: "accepted", scanRunId: started.scanRunId }, { status: 202 });
}
