import nodemailer from "nodemailer";
import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import type { DigestFrequency } from "@/app/generated/prisma/client";
import { logEvent } from "@/lib/logger";
import { describeChange, type ScanChange } from "./types";
import { digestSubject, digestBody } from "./digest";
import { leadTimeReminderSubject, leadTimeReminderBody } from "./leadTimeReminder";

type Transporter = ReturnType<typeof nodemailer.createTransport>;

// Lazily built and cached: undefined = not yet resolved, null = SMTP_HOST
// isn't configured (alerts are opt-in in the UI regardless of whether an
// operator has actually set up outbound mail, so this must degrade to a
// no-op instead of throwing).
let transporter: Transporter | null | undefined;

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;

  const host = process.env.SMTP_HOST;
  if (!host) {
    transporter = null;
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transporter;
}

function subjectFor(changes: ScanChange[]): string {
  if (changes.length === 1) {
    const [change] = changes;
    return `${change.gameName}: ${change.productSetName} - ${describeChange(change)}`;
  }
  return `${changes.length} updates on your subscribed games`;
}

function bodyFor(changes: ScanChange[]): string {
  return changes.map((change) => `${change.gameName} - ${change.productSetName}: ${describeChange(change)}`).join("\n");
}

/** Sends one email listing every change relevant to this recipient. No-ops (with a log line) when SMTP_HOST isn't configured. */
export async function sendEmailAlert(toEmail: string, changes: ScanChange[]): Promise<void> {
  if (changes.length === 0) return;

  const client = getTransporter();
  if (!client) {
    logEvent({ action: "notifications.sendEmailAlert", outcome: "skipped", reason: "SMTP_HOST not configured" });
    return;
  }

  await client.sendMail({
    from: process.env.SMTP_FROM ?? "Release Watcher <no-reply@releasewatcher.com>",
    to: toEmail,
    subject: subjectFor(changes),
    text: bodyFor(changes),
  });
}

/** Premium digest roundup. No-ops (with a log line) when SMTP_HOST isn't configured, same as sendEmailAlert. */
export async function sendDigestEmail(
  toEmail: string,
  frequency: DigestFrequency,
  events: CalendarEvent[],
): Promise<void> {
  const client = getTransporter();
  if (!client) {
    logEvent({ action: "notifications.sendDigestEmail", outcome: "skipped", reason: "SMTP_HOST not configured" });
    return;
  }

  await client.sendMail({
    from: process.env.SMTP_FROM ?? "Release Watcher <no-reply@releasewatcher.com>",
    to: toEmail,
    subject: digestSubject(frequency, events.length),
    text: digestBody(events),
  });
}

/**
 * Premium lead-time reminder. Unlike sendDigestEmail, only ever called with
 * a non-empty `events` (see leadTimeScheduler.ts) -- "nothing releasing in
 * exactly N days" isn't worth an email the way "nothing new since last
 * digest" is, since there's no fixed cadence promise being confirmed here.
 */
export async function sendLeadTimeReminderEmail(
  toEmail: string,
  days: number,
  events: CalendarEvent[],
): Promise<void> {
  if (events.length === 0) return;

  const client = getTransporter();
  if (!client) {
    logEvent({ action: "notifications.sendLeadTimeReminderEmail", outcome: "skipped", reason: "SMTP_HOST not configured" });
    return;
  }

  await client.sendMail({
    from: process.env.SMTP_FROM ?? "Release Watcher <no-reply@releasewatcher.com>",
    to: toEmail,
    subject: leadTimeReminderSubject(days, events.length),
    text: leadTimeReminderBody(events),
  });
}

/**
 * An operational alarm to an admin's email (lib/ingest/freshness.ts). Same
 * lazily-built transporter and same degrade-to-no-op-when-unconfigured
 * behaviour as every other sender here -- an alarm that throws because SMTP
 * was never set up would take down the pass that was trying to report a
 * problem.
 */
export async function sendAdminAlarmEmail(toEmail: string, subject: string, body: string): Promise<void> {
  const client = getTransporter();
  if (!client) {
    logEvent({ action: "notifications.sendAdminAlarmEmail", outcome: "skipped", reason: "SMTP_HOST not configured" });
    return;
  }

  await client.sendMail({
    from: process.env.SMTP_FROM ?? "Release Watcher <no-reply@releasewatcher.com>",
    to: toEmail,
    subject,
    text: body,
  });
}
