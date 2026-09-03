export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startCrawlerScheduler } = await import("./lib/crawler/scheduler");
  startCrawlerScheduler();
  const { startDigestScheduler } = await import("./lib/notifications/digestScheduler");
  startDigestScheduler();
  const { startLeadTimeReminderScheduler } = await import("./lib/notifications/leadTimeScheduler");
  startLeadTimeReminderScheduler();
}
