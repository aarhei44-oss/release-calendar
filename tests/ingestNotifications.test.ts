import { describe, expect, it } from "vitest";
import { toScanChanges } from "@/lib/ingest/notifications";
import type { RunDiffChange } from "@/lib/ingest/types";

const CONTEXT = new Map([
  ["event-1", { installId: "install-1", gameName: "Pokémon", productSetName: "Mega Evolution" }],
]);

function change(overrides: Partial<RunDiffChange> = {}): RunDiffChange {
  return {
    releaseEventId: "event-1",
    productSetId: "set-1",
    action: "PUBLISH",
    rule: "G1",
    reason: "OFFICIAL_SINGLE",
    before: null,
    after: null,
    statusBefore: "RUMORED",
    statusAfter: "CONFIRMED",
    ...overrides,
  };
}

describe("toScanChanges", () => {
  it("maps a null statusBefore to kind=created", () => {
    const result = toScanChanges([change({ statusBefore: null, statusAfter: "ANNOUNCED" })], CONTEXT);
    expect(result).toEqual([
      {
        installId: "install-1",
        eventId: "event-1",
        gameName: "Pokémon",
        productSetName: "Mega Evolution",
        status: "ANNOUNCED",
        kind: "created",
        previousStatus: undefined,
      },
    ]);
  });

  it("maps a status transition to kind=status_changed", () => {
    const result = toScanChanges([change({ statusBefore: "ANNOUNCED", statusAfter: "CONFIRMED" })], CONTEXT);
    expect(result).toEqual([
      {
        installId: "install-1",
        eventId: "event-1",
        gameName: "Pokémon",
        productSetName: "Mega Evolution",
        status: "CONFIRMED",
        kind: "status_changed",
        previousStatus: "ANNOUNCED",
      },
    ]);
  });

  it("maps a transition into RELEASED to kind=released", () => {
    const result = toScanChanges([change({ statusBefore: "CONFIRMED", statusAfter: "RELEASED" })], CONTEXT);
    expect(result[0].kind).toBe("released");
  });

  it("skips a change with no status transition", () => {
    const result = toScanChanges([change({ statusBefore: "CONFIRMED", statusAfter: "CONFIRMED" })], CONTEXT);
    expect(result).toEqual([]);
  });

  it("skips a change whose event id is missing from context", () => {
    const result = toScanChanges([change({ releaseEventId: "unknown-event", statusBefore: null })], CONTEXT);
    expect(result).toEqual([]);
  });
});
