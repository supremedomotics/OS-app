import type { DeviceId } from "@supreme/domain-model";
import type { BackendStateEvent } from "@supreme/integration-layer";
import { afterEach, describe, expect, it } from "vitest";
import { KnxProtocolDriver } from "../../knx-driver.js";
import { legacyAvailable, legacyHarness, nativeHarness, type ContractHarness } from "./simulator/contract-harnesses.js";

/**
 * D7 (command echo vs observed state), through KnxProtocolDriver, on BOTH the legacy wrapper (modelled knxultimate client — library-source evidence,
 * not a real client) and the native connection (simulator). Documented semantics under test (knx-driver.ts `command()` / `observe()`):
 *   - a sent command is announced as `commanded` and is never stored as state; there is no optimistic update;
 *   - only a telegram on the DECLARED status address (write or response from the bus) is `observed` state;
 *   - the client's own transmission (library `echoed = true`) and a GroupValueRead request are not state.
 * What is NOT decided here: whether a real gateway relays a tunnel's own frame back to it, and which source address a shared-GA
 * feedback may be attributed to — no normative text is held (see docs/knx/knx-native-group-parity-plan.md §8, D7).
 */
const DEV = "device-d7" as DeviceId;
for (const label of ["legacy", "native"] as const) {
  describe.skipIf(label === "legacy" && !legacyAvailable)(`state semantics — ${label}`, () => {
    let h: ContractHarness;
    afterEach(async () => { await h?.close(); });
    async function rig(config: Record<string, unknown>, address = "1/0/1") {
      h = label === "legacy" ? legacyHarness() : nativeHarness();
      await h.connect();
      const driver = new KnxProtocolDriver({ host: "10.0.0.2", createConnection: async () => h.connection });
      const events: BackendStateEvent[] = [];
      driver.onState((e) => events.push(e));
      await driver.bind({ deviceId: DEV, capability: "onoff", address, config: { dpt: "DPT1.001", ...config } });
      await driver.connect();
      return { driver, events };
    }
    const observed = (e: BackendStateEvent[]) => e.filter((x) => x.provenance === "observed");
    const commanded = (e: BackendStateEvent[]) => e.filter((x) => x.provenance === "commanded");

    // NOTE: this case does NOT exercise self-echo filtering. The observed status address (1/0/2) differs from the command address (1/0/1), so
    // the transport-level write's echo lands on a GA nobody here observes. It only pins "commanded is not state / no optimistic update". The
    // echo-filter regression (D7) is the shared-address case below, plus real-library-packets.test.ts.
    it("separate status GA: a command is announced as commanded only — no state, no observed event, no optimistic update", async () => {
      const { driver, events } = await rig({ statusAddress: "1/0/2" });
      await h.write("1/0/1", true, "DPT1.001");                 // the transport-level write (its echo, if any, goes to observers of 1/0/1 — none here, so this proves nothing about echo filtering)
      await h.settle(driver.command(DEV, { capability: "onoff", action: "set", on: true }));
      expect(commanded(events)).toHaveLength(1);
      expect(driver.getState(DEV, "onoff")).toBeNull();
      expect(observed(events)).toEqual([]);
    });

    it("shared command/status GA declared by the installer: the client's own transmission is NOT observed state; a later independent report is", async () => {
      const { driver, events } = await rig({ statusAddress: "1/0/1", feedbackOnCommandAddress: true });
      await h.settle(driver.command(DEV, { capability: "onoff", action: "set", on: true }));
      expect(commanded(events)).toHaveLength(1);
      expect(observed(events)).toEqual([]);                      // before the fix the legacy wrapper recorded the echo here
      expect(driver.getState(DEV, "onoff")).toBeNull();
      await h.deviceWrites("1/0/1", "DPT1.001", false);          // another sender / the device itself reports
      expect(observed(events)).toHaveLength(1);
      expect(driver.getState(DEV, "onoff")).toMatchObject({ kind: "onoff", on: false });   // the report wins over what was requested
    });

    it("independent feedback on the status GA is observed; a GroupValueResponse counts like a write; a GroupValueRead request does not", async () => {
      const { driver, events } = await rig({ statusAddress: "1/0/2" });
      await h.deviceReads("1/0/2");
      expect(observed(events)).toEqual([]);
      expect(driver.getState(DEV, "onoff")).toBeNull();
      await h.deviceWrites("1/0/2", "DPT1.001", true);
      expect(driver.getState(DEV, "onoff")).toMatchObject({ on: true });
      await h.deviceResponds("1/0/2", "DPT1.001", false);
      expect(driver.getState(DEV, "onoff")).toMatchObject({ on: false });
      expect(observed(events)).toHaveLength(2);
    });

    it("duplicate identical telegrams produce one observed event; a changed value produces the next", async () => {
      const { events } = await rig({ statusAddress: "1/0/2" });
      await h.deviceWrites("1/0/2", "DPT1.001", true);
      await h.deviceWrites("1/0/2", "DPT1.001", true);
      await h.deviceResponds("1/0/2", "DPT1.001", true);
      expect(observed(events)).toHaveLength(1);
      await h.deviceWrites("1/0/2", "DPT1.001", false);
      expect(observed(events)).toHaveLength(2);
    });

    it("no declared feedback at all: nothing is ever observed, even if the command GA carries traffic", async () => {
      const { driver, events } = await rig({});
      await h.deviceWrites("1/0/1", "DPT1.001", true);           // another switch writing the same GA is not attributable to this device
      expect(observed(events)).toEqual([]);
      expect(driver.getState(DEV, "onoff")).toBeNull();
    });
  });
}
