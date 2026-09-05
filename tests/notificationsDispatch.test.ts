import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanChange } from "@/lib/notifications/types";
import type { AdminAlertRecipient, InstallSubscriber, EventFollower } from "@/data/notifications/notificationsRepo";

const sendEmailAlert = vi.fn().mockResolvedValue(undefined);
const sendDiscordAlert = vi.fn().mockResolvedValue(undefined);
const sendAdminAlarmEmail = vi.fn().mockResolvedValue(undefined);
const sendAdminAlarmDiscord = vi.fn().mockResolvedValue(undefined);
const getSubscribersForInstalls = vi.fn<(installIds: string[]) => Promise<InstallSubscriber[]>>();
const getFollowersForEvents = vi.fn<(eventIds: string[]) => Promise<EventFollower[]>>();
const getAdminAlertRecipients = vi.fn<() => Promise<AdminAlertRecipient[]>>();

vi.mock("@/lib/notifications/email", () => ({
  sendEmailAlert: (...args: unknown[]) => sendEmailAlert(...args),
  sendAdminAlarmEmail: (...args: unknown[]) => sendAdminAlarmEmail(...args),
}));
vi.mock("@/lib/notifications/discord", () => ({
  sendDiscordAlert: (...args: unknown[]) => sendDiscordAlert(...args),
  sendAdminAlarmDiscord: (...args: unknown[]) => sendAdminAlarmDiscord(...args),
}));
vi.mock("@/data/notifications/notificationsRepo", () => ({
  getSubscribersForInstalls: (...args: [string[]]) => getSubscribersForInstalls(...args),
  getFollowersForEvents: (...args: [string[]]) => getFollowersForEvents(...args),
  getAdminAlertRecipients: (...args: []) => getAdminAlertRecipients(...args),
}));

function adminRecipient(overrides: Partial<AdminAlertRecipient> = {}): AdminAlertRecipient {
  return {
    userId: "admin-1",
    email: "admin@example.com",
    emailAlertsEnabled: true,
    discordWebhookUrl: null,
    discordAlertsEnabled: false,
    ...overrides,
  };
}

function follower(overrides: Partial<EventFollower> = {}): EventFollower {
  return {
    userId: "follower-1",
    eventId: "event-1",
    email: "follower@example.com",
    emailAlertsEnabled: true,
    discordWebhookUrl: null,
    discordAlertsEnabled: false,
    ...overrides,
  };
}

function change(overrides: Partial<ScanChange> = {}): ScanChange {
  return {
    installId: "install-1",
    eventId: "event-1",
    gameName: "Magic: The Gathering",
    productSetName: "Foundations",
    status: "CONFIRMED",
    kind: "status_changed",
    ...overrides,
  };
}

function subscriber(overrides: Partial<InstallSubscriber> = {}): InstallSubscriber {
  return {
    userId: "user-1",
    installId: "install-1",
    email: "user@example.com",
    emailAlertsEnabled: true,
    discordWebhookUrl: null,
    discordAlertsEnabled: false,
    ...overrides,
  };
}

beforeEach(() => {
  sendEmailAlert.mockClear();
  sendDiscordAlert.mockClear();
  sendAdminAlarmEmail.mockClear();
  sendAdminAlarmDiscord.mockClear();
  getSubscribersForInstalls.mockReset();
  getSubscribersForInstalls.mockResolvedValue([]);
  getFollowersForEvents.mockReset();
  getFollowersForEvents.mockResolvedValue([]);
  getAdminAlertRecipients.mockReset();
  getAdminAlertRecipients.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dispatchScanChangeNotifications", () => {
  it("does nothing when there are no changes", async () => {
    const { dispatchScanChangeNotifications } = await import("@/lib/notifications/dispatch");
    await dispatchScanChangeNotifications([]);
    expect(getSubscribersForInstalls).not.toHaveBeenCalled();
  });

  it("sends nothing to a subscriber who has email alerts disabled", async () => {
    getSubscribersForInstalls.mockResolvedValue([subscriber({ emailAlertsEnabled: false })]);
    const { dispatchScanChangeNotifications } = await import("@/lib/notifications/dispatch");

    await dispatchScanChangeNotifications([change()]);

    expect(sendEmailAlert).not.toHaveBeenCalled();
  });

  it("emails a subscriber with alerts enabled for their install", async () => {
    getSubscribersForInstalls.mockResolvedValue([subscriber()]);
    const { dispatchScanChangeNotifications } = await import("@/lib/notifications/dispatch");

    await dispatchScanChangeNotifications([change()]);

    expect(sendEmailAlert).toHaveBeenCalledTimes(1);
    expect(sendEmailAlert).toHaveBeenCalledWith("user@example.com", [change()]);
  });

  it("does not notify a subscriber about an install with no changes, even if they're subscribed to a changed one", async () => {
    getSubscribersForInstalls.mockResolvedValue([subscriber({ installId: "install-1" }), subscriber({ installId: "install-2" })]);
    const { dispatchScanChangeNotifications } = await import("@/lib/notifications/dispatch");

    await dispatchScanChangeNotifications([change({ installId: "install-1" })]);

    expect(sendEmailAlert).toHaveBeenCalledTimes(1);
    expect(sendEmailAlert).toHaveBeenCalledWith("user@example.com", [change({ installId: "install-1" })]);
  });

  it("batches multiple changes across a user's subscribed installs into a single send", async () => {
    getSubscribersForInstalls.mockResolvedValue([subscriber({ installId: "install-1" }), subscriber({ installId: "install-2" })]);
    const { dispatchScanChangeNotifications } = await import("@/lib/notifications/dispatch");
    const changeA = change({ installId: "install-1", eventId: "event-a" });
    const changeB = change({ installId: "install-2", eventId: "event-b" });

    await dispatchScanChangeNotifications([changeA, changeB]);

    expect(sendEmailAlert).toHaveBeenCalledTimes(1);
    expect(sendEmailAlert).toHaveBeenCalledWith("user@example.com", [changeA, changeB]);
  });

  it("does not post to Discord for a subscriber with alerts enabled but no webhook URL set", async () => {
    getSubscribersForInstalls.mockResolvedValue([subscriber({ discordAlertsEnabled: true, discordWebhookUrl: null })]);
    const { dispatchScanChangeNotifications } = await import("@/lib/notifications/dispatch");

    await dispatchScanChangeNotifications([change()]);

    expect(sendDiscordAlert).not.toHaveBeenCalled();
  });

  it("does not post to Discord for a subscriber with a webhook URL but alerts disabled", async () => {
    getSubscribersForInstalls.mockResolvedValue([
      subscriber({ discordAlertsEnabled: false, discordWebhookUrl: "https://discord.com/api/webhooks/1/a" }),
    ]);
    const { dispatchScanChangeNotifications } = await import("@/lib/notifications/dispatch");

    await dispatchScanChangeNotifications([change()]);

    expect(sendDiscordAlert).not.toHaveBeenCalled();
  });

  it("posts to Discord for a subscriber with both alerts enabled and a webhook URL set", async () => {
    getSubscribersForInstalls.mockResolvedValue([
      subscriber({ discordAlertsEnabled: true, discordWebhookUrl: "https://discord.com/api/webhooks/1/a" }),
    ]);
    const { dispatchScanChangeNotifications } = await import("@/lib/notifications/dispatch");

    await dispatchScanChangeNotifications([change()]);

    expect(sendDiscordAlert).toHaveBeenCalledTimes(1);
    expect(sendDiscordAlert).toHaveBeenCalledWith("https://discord.com/api/webhooks/1/a", [change()]);
  });

  it("sends both email and Discord independently when a subscriber has both enabled", async () => {
    getSubscribersForInstalls.mockResolvedValue([
      subscriber({
        emailAlertsEnabled: true,
        discordAlertsEnabled: true,
        discordWebhookUrl: "https://discord.com/api/webhooks/1/a",
      }),
    ]);
    const { dispatchScanChangeNotifications } = await import("@/lib/notifications/dispatch");

    await dispatchScanChangeNotifications([change()]);

    expect(sendEmailAlert).toHaveBeenCalledTimes(1);
    expect(sendDiscordAlert).toHaveBeenCalledTimes(1);
  });

  it("keeps sending email when the Discord send for the same user fails", async () => {
    getSubscribersForInstalls.mockResolvedValue([
      subscriber({
        emailAlertsEnabled: true,
        discordAlertsEnabled: true,
        discordWebhookUrl: "https://discord.com/api/webhooks/1/a",
      }),
    ]);
    sendDiscordAlert.mockRejectedValueOnce(new Error("Discord down"));
    const { dispatchScanChangeNotifications } = await import("@/lib/notifications/dispatch");

    await expect(dispatchScanChangeNotifications([change()])).resolves.toBeUndefined();

    expect(sendEmailAlert).toHaveBeenCalledTimes(1);
  });

  it("keeps going for other subscribers when one send fails", async () => {
    getSubscribersForInstalls.mockResolvedValue([
      subscriber({ userId: "user-1", email: "fails@example.com" }),
      subscriber({ userId: "user-2", email: "ok@example.com" }),
    ]);
    sendEmailAlert.mockRejectedValueOnce(new Error("SMTP down")).mockResolvedValueOnce(undefined);
    const { dispatchScanChangeNotifications } = await import("@/lib/notifications/dispatch");

    await expect(dispatchScanChangeNotifications([change()])).resolves.toBeUndefined();

    expect(sendEmailAlert).toHaveBeenCalledTimes(2);
  });

  it("emails a follower of the specific event, even with no install subscription at all", async () => {
    getFollowersForEvents.mockResolvedValue([follower()]);
    const { dispatchScanChangeNotifications } = await import("@/lib/notifications/dispatch");

    await dispatchScanChangeNotifications([change({ eventId: "event-1" })]);

    expect(sendEmailAlert).toHaveBeenCalledTimes(1);
    expect(sendEmailAlert).toHaveBeenCalledWith("follower@example.com", [change({ eventId: "event-1" })]);
  });

  it("does not notify a follower about a different event, even if it's on the same install", async () => {
    getFollowersForEvents.mockResolvedValue([follower({ eventId: "event-1" })]);
    const { dispatchScanChangeNotifications } = await import("@/lib/notifications/dispatch");

    await dispatchScanChangeNotifications([change({ eventId: "event-2", installId: "install-1" })]);

    expect(sendEmailAlert).not.toHaveBeenCalled();
  });

  it("sends one email, not two, to a user who is both an install subscriber and a follower of the changed event", async () => {
    getSubscribersForInstalls.mockResolvedValue([subscriber({ userId: "user-1", installId: "install-1" })]);
    getFollowersForEvents.mockResolvedValue([follower({ userId: "user-1", eventId: "event-1" })]);
    const { dispatchScanChangeNotifications } = await import("@/lib/notifications/dispatch");

    await dispatchScanChangeNotifications([change({ installId: "install-1", eventId: "event-1" })]);

    expect(sendEmailAlert).toHaveBeenCalledTimes(1);
    expect(sendEmailAlert).toHaveBeenCalledWith("user@example.com", [change({ installId: "install-1", eventId: "event-1" })]);
  });

  it("does not duplicate the change in a user's list when it reaches them via both the install and event path", async () => {
    getSubscribersForInstalls.mockResolvedValue([subscriber({ userId: "user-1", installId: "install-1" })]);
    getFollowersForEvents.mockResolvedValue([follower({ userId: "user-1", eventId: "event-1" })]);
    const { dispatchScanChangeNotifications } = await import("@/lib/notifications/dispatch");
    const theChange = change({ installId: "install-1", eventId: "event-1" });

    await dispatchScanChangeNotifications([theChange]);

    const [, changesArg] = sendEmailAlert.mock.calls[0];
    expect(changesArg).toHaveLength(1);
  });
});

describe("dispatchAdminAlarm", () => {
  it("does nothing when there are no active admins", async () => {
    getAdminAlertRecipients.mockResolvedValue([]);
    const { dispatchAdminAlarm } = await import("@/lib/notifications/dispatch");

    await dispatchAdminAlarm({ subject: "s", body: "b" });

    expect(sendAdminAlarmEmail).not.toHaveBeenCalled();
    expect(sendAdminAlarmDiscord).not.toHaveBeenCalled();
  });

  it("emails an admin with email alerts enabled", async () => {
    getAdminAlertRecipients.mockResolvedValue([adminRecipient({ emailAlertsEnabled: true })]);
    const { dispatchAdminAlarm } = await import("@/lib/notifications/dispatch");

    await dispatchAdminAlarm({ subject: "Provider gone quiet", body: "details" });

    expect(sendAdminAlarmEmail).toHaveBeenCalledTimes(1);
    expect(sendAdminAlarmEmail).toHaveBeenCalledWith("admin@example.com", "Provider gone quiet", "details");
  });

  it("does not email an admin who has email alerts disabled", async () => {
    getAdminAlertRecipients.mockResolvedValue([adminRecipient({ emailAlertsEnabled: false })]);
    const { dispatchAdminAlarm } = await import("@/lib/notifications/dispatch");

    await dispatchAdminAlarm({ subject: "s", body: "b" });

    expect(sendAdminAlarmEmail).not.toHaveBeenCalled();
  });

  it("does not post to Discord for an admin with alerts enabled but no webhook URL", async () => {
    getAdminAlertRecipients.mockResolvedValue([
      adminRecipient({ discordAlertsEnabled: true, discordWebhookUrl: null }),
    ]);
    const { dispatchAdminAlarm } = await import("@/lib/notifications/dispatch");

    await dispatchAdminAlarm({ subject: "s", body: "b" });

    expect(sendAdminAlarmDiscord).not.toHaveBeenCalled();
  });

  it("posts to Discord for an admin with both alerts enabled and a webhook URL", async () => {
    getAdminAlertRecipients.mockResolvedValue([
      adminRecipient({ discordAlertsEnabled: true, discordWebhookUrl: "https://discord.com/api/webhooks/1/a" }),
    ]);
    const { dispatchAdminAlarm } = await import("@/lib/notifications/dispatch");

    await dispatchAdminAlarm({ subject: "Provider gone quiet", body: "details" });

    expect(sendAdminAlarmDiscord).toHaveBeenCalledTimes(1);
    expect(sendAdminAlarmDiscord).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/1/a",
      "**Provider gone quiet**\ndetails",
    );
  });

  it("keeps notifying other admins when one admin's email send fails", async () => {
    getAdminAlertRecipients.mockResolvedValue([
      adminRecipient({ userId: "admin-1", email: "fails@example.com" }),
      adminRecipient({ userId: "admin-2", email: "ok@example.com" }),
    ]);
    sendAdminAlarmEmail.mockRejectedValueOnce(new Error("SMTP down")).mockResolvedValueOnce(undefined);
    const { dispatchAdminAlarm } = await import("@/lib/notifications/dispatch");

    await expect(dispatchAdminAlarm({ subject: "s", body: "b" })).resolves.toBeUndefined();

    expect(sendAdminAlarmEmail).toHaveBeenCalledTimes(2);
  });

  it("still sends Discord when email fails for the same admin", async () => {
    getAdminAlertRecipients.mockResolvedValue([
      adminRecipient({
        emailAlertsEnabled: true,
        discordAlertsEnabled: true,
        discordWebhookUrl: "https://discord.com/api/webhooks/1/a",
      }),
    ]);
    sendAdminAlarmEmail.mockRejectedValueOnce(new Error("SMTP down"));
    const { dispatchAdminAlarm } = await import("@/lib/notifications/dispatch");

    await expect(dispatchAdminAlarm({ subject: "s", body: "b" })).resolves.toBeUndefined();

    expect(sendAdminAlarmDiscord).toHaveBeenCalledTimes(1);
  });
});
