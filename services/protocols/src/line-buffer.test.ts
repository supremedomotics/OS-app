import { describe, expect, it, vi } from "vitest";
import { LineAccumulator } from "./line-buffer.js";

describe("LineAccumulator", () => {
  it("splits complete lines and retains a trailing partial line across feeds", () => {
    const acc = new LineAccumulator("\r");
    expect(acc.feed("PWON\rMV5")).toEqual(["PWON"]);
    expect(acc.feed("5\rMUON\r")).toEqual(["MV55", "MUON"]);
  });

  it("supports a multi-character delimiter (HEOS's \\r\\n)", () => {
    const acc = new LineAccumulator("\r\n");
    expect(acc.feed("heos://player/get_players\r\nheos://sy")).toEqual(["heos://player/get_players"]);
    expect(acc.feed("stem/register_for_change_events\r\n")).toEqual(["heos://system/register_for_change_events"]);
  });

  it("never grows without bound — resets and reports overflow when no delimiter arrives within maxBytes (§ Production Hardening, packet-flood audit)", () => {
    const onOverflow = vi.fn();
    const acc = new LineAccumulator("\r", 1_000, onOverflow);
    // A single flood chunk with no delimiter at all, well past maxBytes.
    expect(acc.feed("X".repeat(5_000))).toEqual([]);
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(onOverflow).toHaveBeenCalledWith(5_000);
    // The reset leaves the buffer genuinely empty — a real delimited line fed next
    // parses cleanly, with no leftover flood bytes prepended. The accumulator
    // recovers instead of staying wedged.
    expect(acc.feed("PWON\r")).toEqual(["PWON"]);
  });

  it("keeps resetting on a sustained flood — never lets residual bytes accumulate across many overflow cycles", () => {
    const onOverflow = vi.fn();
    const acc = new LineAccumulator("\r", 1_000, onOverflow);
    for (let i = 0; i < 20; i++) acc.feed("X".repeat(200)); // 4,000 bytes total, no delimiter
    // However many times it overflowed, the buffer can never hold more than maxBytes
    // at the moment of the last feed — prove this indirectly: the very next feed's
    // returned line length is bounded, never the full 4,000-byte flood.
    const lines = acc.feed("\r"); // force a flush of whatever's currently buffered
    expect(lines[0]?.length ?? 0).toBeLessThanOrEqual(1_000);
    expect(onOverflow.mock.calls.length).toBeGreaterThan(0);
  });

  it("does not false-positive overflow on a legitimately long but eventually-delimited burst", () => {
    const onOverflow = vi.fn();
    const acc = new LineAccumulator("\r", 1_000, onOverflow);
    const lines = acc.feed(`${"A".repeat(900)}\r`);
    expect(onOverflow).not.toHaveBeenCalled();
    expect(lines).toEqual(["A".repeat(900)]);
  });
});
