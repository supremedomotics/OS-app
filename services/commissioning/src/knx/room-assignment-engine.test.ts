import { describe, expect, it } from "vitest";
import { parseEtsProject } from "./ets-parser.js";
import { parseGaExport } from "./ga-export-parser.js";
import { recognizeDevices } from "./device-recognition-engine.js";
import { assignRooms } from "./room-assignment-engine.js";

function xmlFile(xml: string): Map<string, Buffer> {
  return new Map([["P-0001/0.xml", Buffer.from(xml, "utf8")]]);
}

describe("room assignment engine", () => {
  it("tier 1: uses the ETS Room a DeviceInstance is directly placed in, plus floor/building", () => {
    const xml = `<KNX>
      <GroupAddresses>
        <GroupAddress Id="GA-1" Address="1/1/1" Name="Kitchen Downlight - Switch" DatapointType="DPST-1-1" />
      </GroupAddresses>
      <Topology>
        <Area Address="1"><Line Address="1">
          <DeviceInstance Id="DI-1" Name="Kitchen Downlight Actuator" Address="1.1.1">
            <ComObjectInstanceRefs>
              <ComObjectInstanceRef RefId="O-1" Text="Switch" DatapointType="DPST-1-1">
                <Connectors><Send GroupAddressRefId="GA-1" /></Connectors>
              </ComObjectInstanceRef>
            </ComObjectInstanceRefs>
          </DeviceInstance>
        </Line></Area>
      </Topology>
      <Locations>
        <Space Type="Building" Name="Villa">
          <Space Type="Floor" Name="Ground Floor">
            <Space Type="Room" Name="Kitchen">
              <DeviceInstanceRef RefId="DI-1" />
            </Space>
          </Space>
        </Space>
      </Locations>
    </KNX>`;
    const model = parseEtsProject(xmlFile(xml));
    const { devices } = recognizeDevices(model);
    const assigned = assignRooms(devices, model);
    expect(assigned[0]?.room).toBe("Kitchen");
    expect(assigned[0]?.floor).toBe("Ground Floor");
    expect(assigned[0]?.building).toBe("Villa");
  });

  it("tier 2: matches the ETS project's own room vocabulary when there's no direct placement", () => {
    const xml = `<KNX>
      <GroupAddresses>
        <GroupAddress Id="GA-1" Address="1/1/1" Name="Dining Hanging" DatapointType="DPST-5-1" />
      </GroupAddresses>
      <Locations>
        <Space Type="Building" Name="Villa">
          <Space Type="Room" Name="Dining" />
        </Space>
      </Locations>
    </KNX>`;
    const model = parseEtsProject(xmlFile(xml));
    const { devices } = recognizeDevices(model);
    const assigned = assignRooms(devices, model);
    expect(assigned[0]?.room).toBe("Dining");
  });

  it("tier 4: falls back to Supreme's already-commissioned room names from the group-address name", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Master Bedroom Sheer Curtains - Position" Address="2/1/1" DPTs="DPST-5-1" />
    </x>`);
    const { devices } = recognizeDevices(model, ["Master Bedroom", "Kitchen"]);
    const assigned = assignRooms(devices, model, ["Master Bedroom", "Kitchen"]);
    expect(assigned[0]?.room).toBe("Master Bedroom");
  });

  it("tier 5: infers a brand-new room from a 'Room - Device - Function' name when nothing else matched", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Wine Cellar - Chiller - Switch" Address="9/1/1" DPTs="DPST-1-1" />
    </x>`);
    const { devices } = recognizeDevices(model);
    const assigned = assignRooms(devices, model, ["Kitchen", "Living Room"]);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.room).toBe("Wine Cellar");
  });

  it("never discards an unmatched device — falls back to Unknown Room when the name has no structure to infer from", () => {
    const model = parseGaExport(`<x>
      <GroupAddress Name="Circuit42Switch" Address="9/1/2" DPTs="DPST-1-1" />
    </x>`);
    const { devices } = recognizeDevices(model);
    const assigned = assignRooms(devices, model, ["Kitchen", "Living Room"]);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.room).toBe("Unknown Room");
  });

  it("prefers the longer/more specific ETS room name match ('Master Bedroom' over 'Bedroom')", () => {
    const xml = `<KNX>
      <GroupAddresses>
        <GroupAddress Id="GA-1" Address="1/1/1" Name="Master Bedroom Reading Light" DatapointType="DPST-1-1" />
      </GroupAddresses>
      <Locations>
        <Space Type="Building" Name="Villa">
          <Space Type="Room" Name="Bedroom" />
          <Space Type="Room" Name="Master Bedroom" />
        </Space>
      </Locations>
    </KNX>`;
    const model = parseEtsProject(xmlFile(xml));
    const { devices } = recognizeDevices(model);
    const assigned = assignRooms(devices, model);
    expect(assigned[0]?.room).toBe("Master Bedroom");
  });
});
