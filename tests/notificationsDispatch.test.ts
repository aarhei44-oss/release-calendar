import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanChange } from "@/lib/notifications/types";
import type { InstallSubscriber } from "@/data/notifications/notificationsRepo";

const sendEmailAlert = vi.fn().mockResolvedValue(undefined);
const getSubscribersForInstalls = vi.fn<(installIds: string[]) => Promise<InstallSubscriber[]>>();

vi.mock("@/lib/notifications/email", () => ({
  sendEmailAlert: (...args: unknown[]) => sendEmailAlert(...args),
}));
vi.mock("@/data/notifications/notificationsRepo", () => ({
  getSubscribersForInstalls: (...args: [string[]]) => getSubscribersForInstalls(...args),
}));

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
    ...overrides,
  };
}

beforeEach(() => {
  sendEmailAlert.mockClear();
  getSubscribersForInstalls.mockReset();
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
});
