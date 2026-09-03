import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanChange } from "@/lib/notifications/types";

const sendMail = vi.fn().mockResolvedValue(undefined);
const createTransport = vi.fn<(options: unknown) => { sendMail: typeof sendMail }>(() => ({ sendMail }));

vi.mock("nodemailer", () => ({
  default: { createTransport: (options: unknown) => createTransport(options) },
}));

const CHANGE: ScanChange = {
  installId: "install-1",
  eventId: "event-1",
  gameName: "Magic: The Gathering",
  productSetName: "Foundations",
  status: "CONFIRMED",
  kind: "status_changed",
  previousStatus: "ANNOUNCED",
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  sendMail.mockClear();
  createTransport.mockClear();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.SMTP_HOST;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("sendEmailAlert", () => {
  it("no-ops without throwing when SMTP_HOST isn't configured", async () => {
    const { sendEmailAlert } = await import("@/lib/notifications/email");
    await expect(sendEmailAlert("user@example.com", [CHANGE])).resolves.toBeUndefined();
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("does nothing for an empty change list even with SMTP configured", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    const { sendEmailAlert } = await import("@/lib/notifications/email");
    await sendEmailAlert("user@example.com", []);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("sends one email summarizing every change when SMTP is configured", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_FROM = "Alerts <alerts@example.com>";
    const { sendEmailAlert } = await import("@/lib/notifications/email");

    await sendEmailAlert("user@example.com", [CHANGE]);

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe("user@example.com");
    expect(mail.from).toBe("Alerts <alerts@example.com>");
    expect(mail.subject).toContain("Magic: The Gathering");
    expect(mail.text).toContain("Foundations");
    expect(mail.text).toContain("ANNOUNCED -> CONFIRMED");
  });

  it("reuses one transporter across multiple sends instead of reconnecting each time", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    const { sendEmailAlert } = await import("@/lib/notifications/email");

    await sendEmailAlert("a@example.com", [CHANGE]);
    await sendEmailAlert("b@example.com", [CHANGE]);

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });
});
