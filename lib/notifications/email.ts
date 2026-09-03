import nodemailer from "nodemailer";
import { logEvent } from "@/lib/logger";
import { describeChange, type ScanChange } from "./types";

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
