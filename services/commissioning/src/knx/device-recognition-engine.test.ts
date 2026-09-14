import { describe, expect, it } from "vitest";
import { parseEtsProject } from "./ets-parser.js";
import { parseGaExport } from "./ga-export-parser.js";
import { recognizeDevices } from "./device-recognition-engine.js";

function xmlFile(xml: string): Map<string, Buffer> {
  return new Map([["P-0001/0.xml", Buffer.from(xml, "utf8")]]);
}

describe("device recognition engine", () => {
  it("merges Switch/Switch-Feedback/Relative-Dimming/Brightness-Feedback into ONE dimmable light, not four entities", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Living Spot 1 - Switch" Address="1/1/1" DPTs="DPST-1-1" />
      <GroupAddress Name="Living Spot 1 - Switch Feedback" Address="1/1/2" DPTs="DPST-1-1" />
      <GroupAddress Name="Living Spot 1 - Relative Dimming" Address="1/1/3" DPTs="DPST-3-7" />
      <GroupAddress Name="Living Spot 1 - Brightness Feedback" Address="1/1/4" DPTs="DPST-5-1" />
    </x>`);
    const { devices } = recognizeDevices(model);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.deviceType).toBe("light_dimmable");
    expect(devices[0]?.supremeType).toBe("dimmer");
    expect(new Set(devices[0]?.bindings.map((b) => b.capability))).toEqual(new Set(["onoff", "brightness"]));
  });

  it("recognizes an RGBWW fixture (combined DPT) as ONE colour light, not per-channel entities", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Media Wall - RGBWW" Address="1/2/1" DPTs="251.600" />
      <GroupAddress Name="Media Wall - Switch" Address="1/2/2" DPTs="DPST-1-1" />
    </x>`);
    const { devices } = recognizeDevices(model);
    const wall = devices.find((d) => d.name.includes("Media Wall"));
    expect(wall?.deviceType).toBe("light_rgbww");
    expect(new Set(wall?.bindings.map((b) => b.capability))).toEqual(new Set(["color", "onoff"]));
  });

  it("recognizes a curtain from Up/Down/Stop/Position/Feedback as ONE cover device", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Master Bedroom Main Curtain - Up/Down" Address="2/1/1" DPTs="DPST-1-8" />
      <GroupAddress Name="Master Bedroom Main Curtain - Stop" Address="2/1/2" DPTs="DPST-1-10" />
      <GroupAddress Name="Master Bedroom Main Curtain - Position" Address="2/1/3" DPTs="DPST-5-1" />
      <GroupAddress Name="Master Bedroom Main Curtain - Position Feedback" Address="2/1/4" DPTs="DPST-5-1" />
    </x>`);
    const { devices } = recognizeDevices(model, ["Master Bedroom"]);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.deviceType).toBe("curtain");
    expect(devices[0]?.room).toBeNull(); // room assignment is a separate stage
    expect(devices[0]?.bindings.some((b) => b.capability === "position")).toBe(true);
  });

  it(
    "recognizes a curtain named just \"Main\" (no cover keyword anywhere) as a curtain, not a dimmable light (§ live-confirmed fix)",
    () => {
      // No "curtain"/"blind"/"shutter" keyword anywhere in the name — the ONLY signal
      // this is a cover is the DPT itself: DPST-1-8 (Up/Down) is structurally unambiguous
      // regardless of naming, unlike the percentage position/feedback GA (DPST-5-1),
      // which really is DPT-ambiguous with a dimmer's and correctly still needs a
      // keyword-driven tiebreaker — this fixture deliberately omits any such keyword to
      // isolate the up/down signal.
      const model = parseGaExport(`<x>
        <GroupAddress Name="Main - Up/Down" Address="2/2/1" DPTs="DPST-1-8" />
        <GroupAddress Name="Main - Position" Address="2/2/2" DPTs="DPST-5-1" />
        <GroupAddress Name="Main - Position Feedback" Address="2/2/3" DPTs="DPST-5-1" />
      </x>`);
      const { devices } = recognizeDevices(model);
      expect(devices).toHaveLength(1);
      expect(devices[0]?.deviceType).toBe("curtain");
      expect(devices[0]?.bindings.some((b) => b.capability === "position")).toBe(true);
    },
  );

  it("recognizes a scene-recall address as a 'scene' device but does not fabricate a capability binding", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Evening Scene - Recall" Address="3/1/1" DPTs="DPST-18-1" />
    </x>`);
    const { devices, warnings } = recognizeDevices(model);
    expect(devices).toHaveLength(0); // zero real capabilities → not committable, never fabricated
    expect(warnings.some((w) => w.code === "orphan_address")).toBe(true);
  });

  it("recognizes an energy meter's Power/Voltage/Current as three devices, one per measurement", () => {
    // Supreme's per-device state is keyed by capability kind — a device can hold at most
    // one "sensor" reading at a time, so three independent measurements on one physical
    // meter become three device cards rather than silently dropping two of them.
    const model = parseGaExport(`<x>
      <GroupAddress Name="Main Meter - Power" Address="4/1/1" DPTs="14.056" />
      <GroupAddress Name="Main Meter - Voltage" Address="4/1/2" DPTs="14.027" />
      <GroupAddress Name="Main Meter - Current" Address="4/1/3" DPTs="14.019" />
    </x>`);
    const { devices } = recognizeDevices(model);
    expect(devices).toHaveLength(3);
    expect(devices.every((d) => d.deviceType === "energy_meter")).toBe(true);
    expect(devices.every((d) => d.bindings.length === 1 && d.bindings[0]?.capability === "sensor")).toBe(true);
    expect(new Set(devices.map((d) => d.name))).toEqual(
      new Set(["Main Meter — Power", "Main Meter — Voltage", "Main Meter — Current"]),
    );
  });

  it("attaches a single extra sensor reading directly onto a non-sensor device instead of splitting it off", () => {
    // A switch actuator with one built-in humidity sensor: no collision, so it's a
    // genuine additional capability of the SAME device, not a split.
    const model = parseGaExport(`<x>
      <GroupAddress Name="Utility Fan - Switch" Address="8/1/1" DPTs="DPST-1-1" />
      <GroupAddress Name="Utility Fan - Humidity" Address="8/1/2" DPTs="9.007" />
    </x>`);
    const { devices } = recognizeDevices(model);
    expect(devices).toHaveLength(1);
    expect(new Set(devices[0]?.bindings.map((b) => b.capability))).toEqual(new Set(["onoff", "sensor"]));
  });

  it("classifies a thermostat and binds its setpoint, with the DPT20.102 and DPT20.105 objects absorbed as hvacRoles (§ Phase 3.3C-1/3.3C-2 — previously reported as unbound waste; both are now correctly recognized, not thrown away)", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Living Room Thermostat - Setpoint" Address="5/1/1" DPTs="9.001" />
      <GroupAddress Name="Living Room Thermostat - Mode" Address="5/1/2" DPTs="20.102" />
      <GroupAddress Name="Living Room Thermostat - Actual Mode" Address="5/1/3" DPTs="20.105" />
    </x>`);
    const { devices, warnings } = recognizeDevices(model);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.deviceType).toBe("thermostat");
    expect(devices[0]?.bindings).toEqual([
      expect.objectContaining({
        capability: "temperature",
        role: "temperature_setpoint",
        hvacRoles: expect.arrayContaining([
          { semanticRole: "operatingMode", address: "5/1/2", dpt: "20.102" },
          { semanticRole: "controllingModeExtended", address: "5/1/3", dpt: "20.105" },
        ]),
      }),
    ]);
    // Neither DPT produces an unused/orphan warning anymore — both are real, recognized
    // HVAC roles now, not discarded objects.
    expect(warnings.some((w) => w.code === "unused_object" && w.message.includes("Thermostat"))).toBe(false);
  });

  it("prefers a writable address over a status/feedback address, keeping the feedback as statusAddress", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Hall Light - Switch Feedback" Address="6/1/1" DPTs="DPST-1-1" />
      <GroupAddress Name="Hall Light - Switch" Address="6/1/2" DPTs="DPST-1-1" />
    </x>`);
    const { devices } = recognizeDevices(model);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.bindings).toHaveLength(1);
    expect(devices[0]?.bindings[0]?.address).toBe("6/1/2"); // the writable "Switch", not the feedback
    expect(devices[0]?.bindings[0]?.statusAddress).toBe("6/1/1"); // feedback preserved, not discarded
  });

  it("pairs a thermostat's ambient reading as the setpoint binding's statusAddress", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Study Thermostat - Setpoint" Address="5/2/1" DPTs="9.001" />
      <GroupAddress Name="Study Thermostat - Current Temp" Address="5/2/2" DPTs="9.001" />
    </x>`);
    const { devices } = recognizeDevices(model);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.bindings).toEqual([
      expect.objectContaining({ capability: "temperature", address: "5/2/1", statusAddress: "5/2/2" }),
    ]);
  });

  it("uses DeviceInstance-backed comm objects for full (1.0) confidence when Topology is present", () => {
    const xml = `<KNX>
      <GroupAddresses>
        <GroupAddress Id="GA-1" Address="1/1/1" Name="Kitchen Downlight - Switch" DatapointType="DPST-1-1" />
      </GroupAddresses>
      <Topology>
        <Area Address="1"><Line Address="1">
          <DeviceInstance Id="DI-1" Name="Kitchen Downlight Actuator" Address="1.1.1">
            <ComObjectInstanceRefs>
              <ComObjectInstanceRef RefId="O-1" Text="Switch" DatapointType="DPST-1-1" WriteFlag="Enabled">
                <Connectors><Send GroupAddressRefId="GA-1" /></Connectors>
              </ComObjectInstanceRef>
            </ComObjectInstanceRefs>
          </DeviceInstance>
        </Line></Area>
      </Topology>
    </KNX>`;
    const model = parseEtsProject(xmlFile(xml));
    const { devices } = recognizeDevices(model);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.confidence).toBe(1);
    expect(devices[0]?.sourceDeviceInstanceId).toBe("DI-1");
  });

  it("flags duplicate addresses, missing DPTs, and unknown DPTs as warnings without failing the import", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Room A" Address="7/1/1" DPTs="DPST-1-1" />
      <GroupAddress Name="No DPT Address" Address="7/1/2" />
    </x>`);
    // Simulate a duplicate by inserting a second GA record with the same address.
    model.groupAddresses.set("dup-1", {
      id: "dup-1", address: "7/1/1", name: "Duplicate", description: null, comment: null,
      dpt: "1.001", mainGroup: null, middleGroup: null, comObjectIds: [],
    });
    const { warnings } = recognizeDevices(model);
    expect(warnings.some((w) => w.code === "duplicate_address")).toBe(true);
    expect(warnings.some((w) => w.code === "missing_dpt")).toBe(true);
  });

  it("clusters a CSV export's bare Main/Middle/Sub leaf names (Up/Down) into ONE curtain, not one device per address", () => {
    // ETS's own "Export Group Addresses" CSV: the Middle Group carries the device identity
    // ("Main Curtain"), while each leaf's own name (the Sub column) is often just a bare
    // parameter word with no identity of its own — clustering on the leaf name alone
    // previously split every Up/Down/Position address into its own separate device.
    const csv = [
      `"Main";"Middle";"Sub";"Address";"Central";"Unfiltered";"Description";"DatapointType"`,
      `"Living Room";"Main Curtain";"";"1/1/-";"";"";"";""`,
      `"";"";"Up";"1/1/1";"";"";"";"DPST-1-8"`,
      `"";"";"Down";"1/1/2";"";"";"";"DPST-1-8"`,
      `"";"";"Position";"1/1/3";"";"";"";"DPST-5-1"`,
    ].join("\n");
    const model = parseGaExport(csv);
    const { devices } = recognizeDevices(model, ["Living Room"]);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.deviceType).toBe("curtain");
    expect(devices[0]?.bindings.some((b) => b.capability === "position")).toBe(true);
  });

  it("clusters a CSV export's bare Switch/Status/Dimming leaf names into ONE dimmable light", () => {
    const csv = [
      `"Main";"Middle";"Sub";"Address";"Central";"Unfiltered";"Description";"DatapointType"`,
      `"All Lights";"Master Control";"";"0/0/-";"";"";"";""`,
      `"";"";"SW";"0/0/1";"";"";"";"DPST-1-1"`,
      `"";"";"SW Status";"0/0/2";"";"";"";"DPST-1-1"`,
      `"";"";"Dimm";"0/0/3";"";"";"";"DPST-5-1"`,
    ].join("\n");
    const model = parseGaExport(csv);
    const { devices } = recognizeDevices(model);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.deviceType).toBe("light_dimmable");
    expect(new Set(devices[0]?.bindings.map((b) => b.capability))).toEqual(new Set(["onoff", "brightness"]));
  });

  it("does not create independent devices from a single multi-channel DeviceInstance", () => {
    // An 8-fold actuator: one DeviceInstance owns 2 unrelated circuits (2 comm objects
    // each) — must NOT collapse into one device just because they share a DeviceInstance.
    const xml = `<KNX>
      <GroupAddresses>
        <GroupAddress Id="GA-1" Address="1/1/1" Name="Living Room Ceiling - Switch" DatapointType="DPST-1-1" />
        <GroupAddress Id="GA-2" Address="1/1/2" Name="Dining Room Ceiling - Switch" DatapointType="DPST-1-1" />
      </GroupAddresses>
      <Topology>
        <Area Address="1"><Line Address="1">
          <DeviceInstance Id="DI-1" Name="8-Fold Switch Actuator" Address="1.1.1">
            <ComObjectInstanceRefs>
              <ComObjectInstanceRef RefId="O-1" Text="Switch" DatapointType="DPST-1-1">
                <Connectors><Send GroupAddressRefId="GA-1" /></Connectors>
              </ComObjectInstanceRef>
              <ComObjectInstanceRef RefId="O-2" Text="Switch" DatapointType="DPST-1-1">
                <Connectors><Send GroupAddressRefId="GA-2" /></Connectors>
              </ComObjectInstanceRef>
            </ComObjectInstanceRefs>
          </DeviceInstance>
        </Line></Area>
      </Topology>
    </KNX>`;
    const model = parseEtsProject(xmlFile(xml));
    const { devices } = recognizeDevices(model, ["Living Room", "Dining Room"]);
    expect(devices).toHaveLength(2);
    expect(new Set(devices.map((d) => d.room))).toEqual(new Set([null])); // room assignment is a later stage
  });
});

describe("§ Phase 3.3B — KNX HVAC Multi-GA Entity/Binding Architecture", () => {
  it("one HVAC cluster (setpoint + ambient + mode GAs) becomes ONE entity with the mode GA attached as an hvacRoles entry, not discarded", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Living Room AC - Setpoint" Address="3/1/1" DPTs="DPST-9-1" />
      <GroupAddress Name="Living Room AC - Current Temperature" Address="3/1/2" DPTs="DPST-9-1" />
      <GroupAddress Name="Living Room AC - Mode" Address="3/1/3" DPTs="DPST-20-102" />
    </x>`);
    const { devices } = recognizeDevices(model, ["Living Room"]);
    const ac = devices.find((d) => d.name.includes("AC"));
    expect(ac).toBeTruthy();
    expect(devices).toHaveLength(1); // not split into a separate "unbound" device

    const tempBinding = ac!.bindings.find((b) => b.capability === "temperature")!;
    expect(tempBinding).toBeTruthy();
    expect(tempBinding.address).toBe("3/1/1"); // setpoint remains the primary write address
    expect(tempBinding.statusAddress).toBe("3/1/2"); // ambient remains the status/feedback address — unchanged behavior

    // The mode GA is preserved with its OWN semantic role, never silently dropped and
    // never collapsed into the primary address/statusAddress pair.
    expect(tempBinding.hvacRoles).toEqual([{ semanticRole: "operatingMode", address: "3/1/3", dpt: "20.102" }]);
  });

  it("existing single-GA temperature entities (no mode GA present) are completely unaffected — hvacRoles is absent, not an empty array with side effects", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Bathroom Floor Setpoint" Address="4/1/1" DPTs="DPST-9-1" />
    </x>`);
    const { devices } = recognizeDevices(model, ["Bathroom"]);
    const tempBinding = devices[0]!.bindings.find((b) => b.capability === "temperature")!;
    expect(tempBinding.hvacRoles).toBeUndefined();
  });

  it("an HVAC mode GA with NO nearby setpoint/ambient GA is reported unbound, same honest treatment as any other orphaned object — never silently dropped, never fabricated into its own device", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Server Room Mode" Address="5/1/1" DPTs="DPST-20-102" />
    </x>`);
    const { devices, warnings } = recognizeDevices(model, ["Server Room"]);
    expect(devices).toHaveLength(0);
    expect(warnings.some((w) => w.context?.addresses?.includes("5/1/1"))).toBe(true);
  });

  it("hvac_fan_speed is NOT absorbed as an hvacRoles entry — fan speed stays out of scope for the universal HVAC model", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Office AC - Setpoint" Address="6/1/1" DPTs="DPST-9-1" />
      <GroupAddress Name="Office AC - Fan Speed" Address="6/1/2" DPTs="DPST-5-1" />
    </x>`);
    const { devices, warnings } = recognizeDevices(model, ["Office"]);
    const ac = devices.find((d) => d.name.includes("AC"))!;
    const tempBinding = ac.bindings.find((b) => b.capability === "temperature")!;
    // Either absent, or (if the fan-speed GA collided on a different capability entirely)
    // certainly never present as an hvacRoles entry.
    expect(tempBinding.hvacRoles?.some((r) => r.semanticRole !== "operatingMode")).toBeFalsy();
    void warnings;
  });

  it("§ Phase 3.3C-2 A/B — DPT 20.105 is recognized as hvacRoles.controllingModeExtended and joins the SAME HVAC entity as the setpoint/ambient/operatingMode GAs", () => {
    // § Naming note: "Actual Mode" (not "Controlling Mode") — both words are in this
    // engine's FUNCTION_WORDS strip-list, so the cluster still collapses to base name
    // "Office AC" alongside the other three GAs; an unrecognized word here (e.g. a raw
    // "Contr") would split this GA into its own device BEFORE role/DPT classification
    // ever runs — a naming-fixture concern, not a signal this architecture is DPT-driven
    // (confirmed: `classifyRole` resolves "hvac_contr_mode" from the DPT alone, §4).
    const model = parseGaExport(`<x>
      <GroupAddress Name="Office AC - Setpoint" Address="8/2/1" DPTs="DPST-9-1" />
      <GroupAddress Name="Office AC - Current Temperature" Address="8/2/2" DPTs="DPST-9-1" />
      <GroupAddress Name="Office AC - Mode" Address="8/2/3" DPTs="DPST-20-102" />
      <GroupAddress Name="Office AC - Actual Mode" Address="8/2/4" DPTs="DPST-20-105" />
    </x>`);
    const { devices } = recognizeDevices(model, ["Office"]);
    expect(devices).toHaveLength(1); // one entity, not split
    const tempBinding = devices[0]!.bindings.find((b) => b.capability === "temperature")!;
    expect(tempBinding.address).toBe("8/2/1");
    expect(tempBinding.statusAddress).toBe("8/2/2");
    expect(tempBinding.hvacRoles).toEqual(
      expect.arrayContaining([
        { semanticRole: "operatingMode", address: "8/2/3", dpt: "20.102" },
        { semanticRole: "controllingModeExtended", address: "8/2/4", dpt: "20.105" },
      ]),
    );
    expect(tempBinding.hvacRoles).toHaveLength(2); // both coexist, neither collapses the other
  });

  it("§ Phase 3.3C-2 — a standalone DPT 20.105 GA with no primary temperature GA nearby is reported unbound, never fabricated into its own HVAC device", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Server Room Controlling Mode" Address="9/1/1" DPTs="DPST-20-105" />
    </x>`);
    const { devices, warnings } = recognizeDevices(model, ["Server Room"]);
    expect(devices).toHaveLength(0);
    expect(warnings.some((w) => w.context?.addresses?.includes("9/1/1"))).toBe(true);
  });

  it("§ Phase 3.3C-2 fix regression — DPT 20.105 is no longer classified 'hvac_fan_speed'; a real fan-speed-labeled percentage GA is unaffected by this fix", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Office AC - Setpoint" Address="10/1/1" DPTs="DPST-9-1" />
      <GroupAddress Name="Office AC - Fan Speed" Address="10/1/2" DPTs="DPST-5-1" />
      <GroupAddress Name="Office AC - Actual Mode" Address="10/1/3" DPTs="DPST-20-105" />
    </x>`);
    const { devices } = recognizeDevices(model, ["Office"]);
    const tempBinding = devices.find((d) => d.name.includes("AC"))!.bindings.find((b) => b.capability === "temperature")!;
    // The real DPT5.001 "Fan Speed" GA never becomes an hvacRoles entry (unrelated DPT);
    // the DPT20.105 GA correctly does.
    expect(tempBinding.hvacRoles).toEqual([{ semanticRole: "controllingModeExtended", address: "10/1/3", dpt: "20.105" }]);
  });

  it("two independent HVAC clusters in the same import keep fully independent hvacRoles bindings — no cross-talk", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Bedroom A AC - Setpoint" Address="7/1/1" DPTs="DPST-9-1" />
      <GroupAddress Name="Bedroom A AC - Mode" Address="7/1/2" DPTs="DPST-20-102" />
      <GroupAddress Name="Bedroom B AC - Setpoint" Address="7/2/1" DPTs="DPST-9-1" />
      <GroupAddress Name="Bedroom B AC - Mode" Address="7/2/2" DPTs="DPST-20-102" />
    </x>`);
    const { devices } = recognizeDevices(model, ["Bedroom A", "Bedroom B"]);
    const a = devices.find((d) => d.name.includes("Bedroom A"))!.bindings.find((b) => b.capability === "temperature")!;
    const b = devices.find((d) => d.name.includes("Bedroom B"))!.bindings.find((b) => b.capability === "temperature")!;
    expect(a.hvacRoles).toEqual([{ semanticRole: "operatingMode", address: "7/1/2", dpt: "20.102" }]);
    expect(b.hvacRoles).toEqual([{ semanticRole: "operatingMode", address: "7/2/2", dpt: "20.102" }]);
  });

  it("§ Phase 3.3C-3 A — DPT 1.100 is recognized as hvacRoles.heatCool and joins the SAME HVAC entity as the setpoint/ambient/operatingMode/controllingModeExtended GAs", () => {
    // § Naming note: "Status" is a FUNCTION_WORDS strip word (unlike "Heat/Cool" itself),
    // so this GA still clusters into base name "Office AC" alongside the other three —
    // recognition is DPT-driven (§4), this is purely a test-fixture clustering concern,
    // same as the 3.3C-2 "Actual Mode" naming note above.
    const model = parseGaExport(`<x>
      <GroupAddress Name="Office AC - Setpoint" Address="11/1/1" DPTs="DPST-9-1" />
      <GroupAddress Name="Office AC - Current Temperature" Address="11/1/2" DPTs="DPST-9-1" />
      <GroupAddress Name="Office AC - Mode" Address="11/1/3" DPTs="DPST-20-102" />
      <GroupAddress Name="Office AC - Actual Mode" Address="11/1/4" DPTs="DPST-20-105" />
      <GroupAddress Name="Office AC - Status" Address="11/1/5" DPTs="DPST-1-100" />
    </x>`);
    const { devices } = recognizeDevices(model, ["Office"]);
    expect(devices).toHaveLength(1); // one entity, not split
    const tempBinding = devices[0]!.bindings.find((b) => b.capability === "temperature")!;
    expect(tempBinding.address).toBe("11/1/1");
    expect(tempBinding.statusAddress).toBe("11/1/2");
    expect(tempBinding.hvacRoles).toEqual(
      expect.arrayContaining([
        { semanticRole: "operatingMode", address: "11/1/3", dpt: "20.102" },
        { semanticRole: "controllingModeExtended", address: "11/1/4", dpt: "20.105" },
        { semanticRole: "heatCool", address: "11/1/5", dpt: "1.100" },
      ]),
    );
    expect(tempBinding.hvacRoles).toHaveLength(3); // all three coexist, none collapses another
  });

  it("§ Phase 3.3C-3 — a standalone DPT 1.100 GA with no primary temperature GA nearby is reported unbound, never fabricated into its own HVAC device", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Server Room Status" Address="12/1/1" DPTs="DPST-1-100" />
    </x>`);
    const { devices, warnings } = recognizeDevices(model, ["Server Room"]);
    expect(devices).toHaveLength(0);
    expect(warnings.some((w) => w.context?.addresses?.includes("12/1/1"))).toBe(true);
  });

  it("§ Phase 3.3C-3 — DPT 1.100 is never classified as a generic binary switch, even though its encoding is one bit", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Office AC - Setpoint" Address="13/1/1" DPTs="DPST-9-1" />
      <GroupAddress Name="Office AC - Status" Address="13/1/2" DPTs="DPST-1-100" />
    </x>`);
    const { devices } = recognizeDevices(model, ["Office"]);
    const tempBinding = devices.find((d) => d.name.includes("AC"))!.bindings.find((b) => b.capability === "temperature")!;
    expect(tempBinding.hvacRoles).toEqual([{ semanticRole: "heatCool", address: "13/1/2", dpt: "1.100" }]);
    // And it must not ALSO show up as a separate onoff device (would prove it was
    // misclassified as a plain switch rather than absorbed as an hvacRoles entry).
    expect(devices.some((d) => d.bindings.some((b) => b.capability === "onoff"))).toBe(false);
  });

  it("three independent HVAC semantic roles (operatingMode/controllingModeExtended/heatCool) fully coexist without cross-clobbering, in either telegram/declaration order", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Loft AC - Setpoint" Address="14/1/1" DPTs="DPST-9-1" />
      <GroupAddress Name="Loft AC - Status" Address="14/1/2" DPTs="DPST-1-100" />
      <GroupAddress Name="Loft AC - Mode" Address="14/1/3" DPTs="DPST-20-102" />
      <GroupAddress Name="Loft AC - Actual Mode" Address="14/1/4" DPTs="DPST-20-105" />
    </x>`);
    const { devices } = recognizeDevices(model, ["Loft"]);
    const tempBinding = devices[0]!.bindings.find((b) => b.capability === "temperature")!;
    expect(tempBinding.hvacRoles).toEqual(
      expect.arrayContaining([
        { semanticRole: "heatCool", address: "14/1/2", dpt: "1.100" },
        { semanticRole: "operatingMode", address: "14/1/3", dpt: "20.102" },
        { semanticRole: "controllingModeExtended", address: "14/1/4", dpt: "20.105" },
      ]),
    );
    expect(tempBinding.hvacRoles).toHaveLength(3);
  });

  it("§ Phase 3.3C-4 A/B — DPT 22.101 is recognized as hvacRoles.status and joins the SAME HVAC entity as the setpoint/ambient/operatingMode/controllingModeExtended/heatCool GAs", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Office AC - Setpoint" Address="15/1/1" DPTs="DPST-9-1" />
      <GroupAddress Name="Office AC - Current Temperature" Address="15/1/2" DPTs="DPST-9-1" />
      <GroupAddress Name="Office AC - Mode" Address="15/1/3" DPTs="DPST-20-102" />
      <GroupAddress Name="Office AC - Actual Mode" Address="15/1/4" DPTs="DPST-20-105" />
      <GroupAddress Name="Office AC - Status" Address="15/1/5" DPTs="DPST-22-101" />
    </x>`);
    const { devices } = recognizeDevices(model, ["Office"]);
    expect(devices).toHaveLength(1); // one entity, not split
    const tempBinding = devices[0]!.bindings.find((b) => b.capability === "temperature")!;
    expect(tempBinding.address).toBe("15/1/1");
    expect(tempBinding.statusAddress).toBe("15/1/2");
    expect(tempBinding.hvacRoles).toEqual(
      expect.arrayContaining([
        { semanticRole: "operatingMode", address: "15/1/3", dpt: "20.102" },
        { semanticRole: "controllingModeExtended", address: "15/1/4", dpt: "20.105" },
        { semanticRole: "status", address: "15/1/5", dpt: "22.101" },
      ]),
    );
    expect(tempBinding.hvacRoles).toHaveLength(3);
  });

  it("§ Phase 3.3C-4 — a standalone DPT 22.101 GA with no primary temperature GA nearby is reported unbound, never fabricated into its own HVAC device", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Server Room Status" Address="16/1/1" DPTs="DPST-22-101" />
    </x>`);
    const { devices, warnings } = recognizeDevices(model, ["Server Room"]);
    expect(devices).toHaveLength(0);
    expect(warnings.some((w) => w.context?.addresses?.includes("16/1/1"))).toBe(true);
  });

  it("§ Phase 3.3C-4 — DPT 22.101 is never classified as a generic status boolean/onoff device", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Office AC - Setpoint" Address="17/1/1" DPTs="DPST-9-1" />
      <GroupAddress Name="Office AC - Status" Address="17/1/2" DPTs="DPST-22-101" />
    </x>`);
    const { devices } = recognizeDevices(model, ["Office"]);
    const tempBinding = devices.find((d) => d.name.includes("AC"))!.bindings.find((b) => b.capability === "temperature")!;
    expect(tempBinding.hvacRoles).toEqual([{ semanticRole: "status", address: "17/1/2", dpt: "22.101" }]);
    expect(devices.some((d) => d.bindings.some((b) => b.capability === "onoff"))).toBe(false);
  });

  it("four independent HVAC semantic roles (operatingMode/controllingModeExtended/heatCool/status) fully coexist without cross-clobbering", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Loft AC - Setpoint" Address="18/1/1" DPTs="DPST-9-1" />
      <GroupAddress Name="Loft AC - Status" Address="18/1/2" DPTs="DPST-1-100" />
      <GroupAddress Name="Loft AC - Mode" Address="18/1/3" DPTs="DPST-20-102" />
      <GroupAddress Name="Loft AC - Actual Mode" Address="18/1/4" DPTs="DPST-20-105" />
      <GroupAddress Name="Loft AC - State" Address="18/1/5" DPTs="DPST-22-101" />
    </x>`);
    const { devices } = recognizeDevices(model, ["Loft"]);
    const tempBinding = devices[0]!.bindings.find((b) => b.capability === "temperature")!;
    expect(tempBinding.hvacRoles).toEqual(
      expect.arrayContaining([
        { semanticRole: "heatCool", address: "18/1/2", dpt: "1.100" },
        { semanticRole: "operatingMode", address: "18/1/3", dpt: "20.102" },
        { semanticRole: "controllingModeExtended", address: "18/1/4", dpt: "20.105" },
        { semanticRole: "status", address: "18/1/5", dpt: "22.101" },
      ]),
    );
    expect(tempBinding.hvacRoles).toHaveLength(4);
  });

  it("§ Phase 3.3C-5B A/C — DPT 222.100 is recognized as ONE hvacRoles.setpoints entry (not three), joining the SAME HVAC entity as the other roles", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Office AC - Setpoint" Address="19/1/1" DPTs="DPST-9-1" />
      <GroupAddress Name="Office AC - Current Temperature" Address="19/1/2" DPTs="DPST-9-1" />
      <GroupAddress Name="Office AC - Mode" Address="19/1/3" DPTs="DPST-20-102" />
      <GroupAddress Name="Office AC - Actual Mode" Address="19/1/4" DPTs="DPST-20-105" />
      <GroupAddress Name="Office AC - Status" Address="19/1/5" DPTs="DPST-22-101" />
      <GroupAddress Name="Office AC - State" Address="19/1/6" DPTs="DPST-222-100" />
    </x>`);
    const { devices } = recognizeDevices(model, ["Office"]);
    expect(devices).toHaveLength(1); // one entity, not split
    const tempBinding = devices[0]!.bindings.find((b) => b.capability === "temperature")!;
    expect(tempBinding.address).toBe("19/1/1");
    expect(tempBinding.statusAddress).toBe("19/1/2");
    expect(tempBinding.hvacRoles).toEqual(
      expect.arrayContaining([
        { semanticRole: "operatingMode", address: "19/1/3", dpt: "20.102" },
        { semanticRole: "controllingModeExtended", address: "19/1/4", dpt: "20.105" },
        { semanticRole: "status", address: "19/1/5", dpt: "22.101" },
        { semanticRole: "setpoints", address: "19/1/6", dpt: "222.100" },
      ]),
    );
    expect(tempBinding.hvacRoles).toHaveLength(4); // one entry per GA, not three for setpoints
  });

  it("§ Phase 3.3C-5B — a standalone DPT 222.100 GA with no primary temperature GA nearby is reported unbound, never fabricated into its own HVAC device", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Server Room State" Address="20/1/1" DPTs="DPST-222-100" />
    </x>`);
    const { devices, warnings } = recognizeDevices(model, ["Server Room"]);
    expect(devices).toHaveLength(0);
    expect(warnings.some((w) => w.context?.addresses?.includes("20/1/1"))).toBe(true);
  });

  it("§ Phase 3.3C-5B — DPT 222.100 is never classified as a generic float/temperature device", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Office AC - Setpoint" Address="21/1/1" DPTs="DPST-9-1" />
      <GroupAddress Name="Office AC - State" Address="21/1/2" DPTs="DPST-222-100" />
    </x>`);
    const { devices } = recognizeDevices(model, ["Office"]);
    const tempBinding = devices.find((d) => d.name.includes("AC"))!.bindings.find((b) => b.capability === "temperature")!;
    expect(tempBinding.hvacRoles).toEqual([{ semanticRole: "setpoints", address: "21/1/2", dpt: "222.100" }]);
    expect(devices).toHaveLength(1); // never split into a second "float" device
  });

  it("five independent HVAC semantic roles (operatingMode/controllingModeExtended/heatCool/status/setpoints) fully coexist without cross-clobbering", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Loft AC - Setpoint" Address="22/1/1" DPTs="DPST-9-1" />
      <GroupAddress Name="Loft AC - Status" Address="22/1/2" DPTs="DPST-1-100" />
      <GroupAddress Name="Loft AC - Mode" Address="22/1/3" DPTs="DPST-20-102" />
      <GroupAddress Name="Loft AC - Actual Mode" Address="22/1/4" DPTs="DPST-20-105" />
      <GroupAddress Name="Loft AC - State" Address="22/1/5" DPTs="DPST-22-101" />
      <GroupAddress Name="Loft AC - Value" Address="22/1/6" DPTs="DPST-222-100" />
    </x>`);
    const { devices } = recognizeDevices(model, ["Loft"]);
    const tempBinding = devices[0]!.bindings.find((b) => b.capability === "temperature")!;
    expect(tempBinding.hvacRoles).toEqual(
      expect.arrayContaining([
        { semanticRole: "heatCool", address: "22/1/2", dpt: "1.100" },
        { semanticRole: "operatingMode", address: "22/1/3", dpt: "20.102" },
        { semanticRole: "controllingModeExtended", address: "22/1/4", dpt: "20.105" },
        { semanticRole: "status", address: "22/1/5", dpt: "22.101" },
        { semanticRole: "setpoints", address: "22/1/6", dpt: "222.100" },
      ]),
    );
    expect(tempBinding.hvacRoles).toHaveLength(5);
  });
});
