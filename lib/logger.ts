/**
 * One structured (JSON-lines) log entry per Server Action call and crawler
 * run, written to stdout for container log collection (technical-spec.md
 * §11). Kept deliberately simple -- no external logging dependency for a
 * single-instance self-hosted app.
 */
export function logEvent(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...fields }));
}

/**
 * Wraps a Server Action body: logs action name, duration, and outcome
 * (success/error) on every call, and includes the error message on
 * failure. Re-throws so callers see the original error untouched.
 */
export async function withActionLogging<T>(action: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    logEvent({ action, durationMs: Date.now() - start, outcome: "success" });
    return result;
  } catch (error) {
    logEvent({
      action,
      durationMs: Date.now() - start,
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
