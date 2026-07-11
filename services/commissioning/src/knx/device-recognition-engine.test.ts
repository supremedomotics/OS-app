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

  it("classifies a thermostat and binds its setpoint, warning about the unbound mode/fan addresses", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Living Room Thermostat - Setpoint" Address="5/1/1" DPTs="9.001" />
      <GroupAddress Name="Living Room Thermostat - Mode" Address="5/1/2" DPTs="20.102" />
      <GroupAddress Name="Living Room Thermostat - Fan" Address="5/1/3" DPTs="20.105" />
    </x>`);
    const { devices, warnings } = recognizeDevices(model);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.deviceType).toBe("thermostat");
    expect(devices[0]?.bindings).toEqual([expect.objectContaining({ capability: "temperature", role: "temperature_setpoint" })]);
    expect(warnings.some((w) => w.code === "unused_object" && w.message.includes("Thermostat"))).toBe(true);
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
