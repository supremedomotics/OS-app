import { describe, expect, it } from "vitest";
import { parseEtsProject } from "./ets-parser.js";

function xmlFile(xml: string): Map<string, Buffer> {
  return new Map([["P-0001/0.xml", Buffer.from(xml, "utf8")]]);
}

describe("ETS project parser", () => {
  it("parses group addresses with their Main/Middle Group and description/comment", () => {
    const xml = `<KNX>
      <GroupAddresses>
        <GroupRange Name="Lighting">
          <GroupRange Name="Switching">
            <GroupAddress Id="GA-1" Address="1/1/1" Name="Living Spot-1" DatapointType="DPST-1-1"
              Description="Living room ceiling spot" Comment="Installed 2024" />
          </GroupRange>
        </GroupRange>
      </GroupAddresses>
    </KNX>`;
    const model = parseEtsProject(xmlFile(xml));
    const ga = model.groupAddresses.get("GA-1");
    expect(ga).toMatchObject({
      address: "1/1/1",
      name: "Living Spot-1",
      dpt: "1.001",
      mainGroup: "Lighting",
      middleGroup: "Switching",
      description: "Living room ceiling spot",
      comment: "Installed 2024",
    });
  });

  it("parses the full Topology tree: device instances, comm objects, flags, and Send/Receive GA refs", () => {
    const xml = `<KNX>
      <GroupAddresses>
        <GroupRange Name="Lighting">
          <GroupAddress Id="GA-1" Address="1/1/1" Name="Living Spot-1 Switch" DatapointType="DPST-1-1" />
          <GroupAddress Id="GA-2" Address="1/1/2" Name="Living Spot-1 Status" DatapointType="DPST-1-1" />
        </GroupRange>
      </GroupAddresses>
      <Topology>
        <Area Address="1">
          <Line Address="1">
            <DeviceInstance Id="M-01_H-1-1-1_DI-1" Name="Living Spot 1 Actuator" Address="1.1.1" ProductRefId="M-01_H-1-1-1_P-1">
              <ComObjectInstanceRefs>
                <ComObjectInstanceRef RefId="O-1_R-1" Text="Switch" Number="1" DatapointType="DPST-1-1"
                  ReadFlag="Disabled" WriteFlag="Enabled" CommunicationFlag="Enabled" TransmitFlag="Disabled" UpdateFlag="Enabled">
                  <Connectors>
                    <Send GroupAddressRefId="GA-1" />
                  </Connectors>
                </ComObjectInstanceRef>
                <ComObjectInstanceRef RefId="O-2_R-1" Text="Switch Status" Number="2" DatapointType="DPST-1-1"
                  ReadFlag="Enabled" WriteFlag="Disabled" CommunicationFlag="Enabled" TransmitFlag="Enabled" UpdateFlag="Disabled">
                  <Connectors>
                    <Send GroupAddressRefId="GA-2" />
                    <Receive GroupAddressRefId="GA-2" />
                  </Connectors>
                </ComObjectInstanceRef>
              </ComObjectInstanceRefs>
            </DeviceInstance>
          </Line>
        </Area>
      </Topology>
      <Locations>
        <Space Type="Building" Name="Villa">
          <Space Type="Floor" Name="Ground Floor">
            <Space Type="Room" Id="SP-Living" Name="Living Room">
              <DeviceInstanceRef RefId="M-01_H-1-1-1_DI-1" />
            </Space>
          </Space>
        </Space>
      </Locations>
    </KNX>`;
    const model = parseEtsProject(xmlFile(xml));

    const device = model.deviceInstances.get("M-01_H-1-1-1_DI-1");
    expect(device?.name).toBe("Living Spot 1 Actuator");
    expect(device?.individualAddress).toBe("1.1.1"); // already-dotted Address is used as-is, not re-composed
    expect(device?.comObjectIds).toHaveLength(2);
    expect(device?.spaceId).toBeTruthy();

    const room = model.spaces.get(device!.spaceId!);
    expect(room?.name).toBe("Living Room");
    expect(room?.type).toBe("room");

    const switchId = device!.comObjectIds[0]!;
    const switchObj = model.communicationObjects.get(switchId);
    expect(switchObj?.groupAddressIds).toEqual(["GA-1"]);
    expect(switchObj?.flags).toMatchObject({ write: true, communicate: true, transmit: false });

    const statusId = device!.comObjectIds[1]!;
    const statusObj = model.communicationObjects.get(statusId);
    expect(statusObj?.flags).toMatchObject({ read: true, transmit: true, write: false });

    // The GA record itself was back-linked to its comm object.
    expect(model.groupAddresses.get("GA-1")?.comObjectIds).toEqual([switchId]);
  });

  it("§ Real ETS5 export compatibility — DeviceInstance Address is only the per-line device number; the full individual address composes Area.Line.Device, and devices on different lines never collide just because their bare device numbers match (confirmed regression: real multi-area/multi-line ETS5 projects were reading a bare single-digit 'Address' as the entire identity before this fix)", () => {
    const xml = `<KNX>
      <Topology>
        <Area Address="1">
          <Line Address="0">
            <DeviceInstance Id="DI-MAIN-1" Name="Main Line Device" Address="1" ProductRefId="M-01_H-1_P-1" />
          </Line>
          <Line Address="1">
            <DeviceInstance Id="DI-NEW-1" Name="New Line Device" Address="1" ProductRefId="M-01_H-1_P-1" />
          </Line>
        </Area>
      </Topology>
    </KNX>`;
    const model = parseEtsProject(xmlFile(xml));
    expect(model.deviceInstances.get("DI-MAIN-1")?.individualAddress).toBe("1.0.1");
    expect(model.deviceInstances.get("DI-NEW-1")?.individualAddress).toBe("1.1.1");
    // Different lines, same bare device number ("1") — must NOT resolve to the same identity.
    expect(model.deviceInstances.get("DI-MAIN-1")?.individualAddress).not.toBe(model.deviceInstances.get("DI-NEW-1")?.individualAddress);
  });

  it("§ Real ETS5 export compatibility — two devices sharing one application program's RefId (e.g. \"O-0_R-1\") stay as separate comm objects, not silently collapsed into one (confirmed regression: a real 217-device project collided 2,954 refs down to 391 map entries before this fix)", () => {
    const xml = `<KNX>
      <GroupAddresses>
        <GroupRange Name="Lighting">
          <GroupAddress Id="GA-1" Address="1/1/1" Name="Device A Command" DatapointType="DPST-1-1" />
          <GroupAddress Id="GA-2" Address="1/1/2" Name="Device B Command" DatapointType="DPST-1-1" />
        </GroupRange>
      </GroupAddresses>
      <Topology>
        <Area Address="1">
          <Line Address="1">
            <DeviceInstance Id="DI-A" Name="Actuator A" Address="1.1.10" ProductRefId="M-01_H-1_P-1">
              <ComObjectInstanceRefs>
                <ComObjectInstanceRef RefId="O-0_R-1" Links="GA-1" />
              </ComObjectInstanceRefs>
            </DeviceInstance>
            <DeviceInstance Id="DI-B" Name="Actuator B" Address="1.1.11" ProductRefId="M-01_H-1_P-1">
              <ComObjectInstanceRefs>
                <ComObjectInstanceRef RefId="O-0_R-1" Links="GA-2" />
              </ComObjectInstanceRefs>
            </DeviceInstance>
          </Line>
        </Area>
      </Topology>
    </KNX>`;
    const model = parseEtsProject(xmlFile(xml));

    const deviceA = model.deviceInstances.get("DI-A")!;
    const deviceB = model.deviceInstances.get("DI-B")!;
    expect(deviceA.comObjectIds).toHaveLength(1);
    expect(deviceB.comObjectIds).toHaveLength(1);
    // Same source RefId ("O-0_R-1") but two DISTINCT model entries, one per device.
    expect(deviceA.comObjectIds[0]).not.toBe(deviceB.comObjectIds[0]);
    expect(model.communicationObjects.size).toBe(2);

    const objA = model.communicationObjects.get(deviceA.comObjectIds[0]!)!;
    const objB = model.communicationObjects.get(deviceB.comObjectIds[0]!)!;
    expect(objA.deviceInstanceId).toBe("DI-A");
    expect(objB.deviceInstanceId).toBe("DI-B");
    expect(objA.groupAddressIds).toEqual(["GA-1"]);
    expect(objB.groupAddressIds).toEqual(["GA-2"]);
  });

  it("§ Real ETS5 export compatibility — a flat Links=\"GA-x GA-y\" attribute on <ComObjectInstanceRef> (no nested <Connectors>) still associates the comm object with its group addresses, both directions", () => {
    const xml = `<KNX>
      <GroupAddresses>
        <GroupRange Name="Lighting">
          <GroupAddress Id="GA-1" Address="1/1/1" Name="Command" DatapointType="DPST-1-1" />
          <GroupAddress Id="GA-2" Address="1/1/2" Name="Central Command" DatapointType="DPST-1-1" />
        </GroupRange>
      </GroupAddresses>
      <Topology>
        <Area Address="1">
          <Line Address="1">
            <DeviceInstance Id="DI-1" Name="Actuator" Address="1.1.20" ProductRefId="M-01_H-1_P-1">
              <ComObjectInstanceRefs>
                <ComObjectInstanceRef RefId="O-0_R-1" Links="GA-1 GA-2" />
              </ComObjectInstanceRefs>
            </DeviceInstance>
          </Line>
        </Area>
      </Topology>
    </KNX>`;
    const model = parseEtsProject(xmlFile(xml));
    const device = model.deviceInstances.get("DI-1")!;
    const obj = model.communicationObjects.get(device.comObjectIds[0]!)!;
    expect(obj.groupAddressIds).toEqual(["GA-1", "GA-2"]);
    // No Send/Receive distinction is available from this schema variant — never
    // fabricated; sendGroupAddressIds/receiveGroupAddressIds stay empty, and downstream
    // role resolution honestly falls back to name/DPT heuristics for these objects.
    expect(obj.sendGroupAddressIds).toEqual([]);
    expect(obj.receiveGroupAddressIds).toEqual([]);
    expect(model.groupAddresses.get("GA-1")?.comObjectIds).toEqual([obj.id]);
    expect(model.groupAddresses.get("GA-2")?.comObjectIds).toEqual([obj.id]);
  });

  it("falls back to the legacy <Function> grouping when there's no Topology", () => {
    const xml = `<KNX>
      <GroupAddresses>
        <GroupRange Name="Lighting">
          <GroupAddress Id="GA-1" Address="2/1/1" Name="Garage Light Switch" DatapointType="DPST-1-1" />
        </GroupRange>
      </GroupAddresses>
      <Locations>
        <Space Type="Building" Name="Villa">
          <Space Type="Room" Name="Garage">
            <Function Id="FN-1" Name="Garage Light">
              <GroupAddressRef RefId="GA-1" />
            </Function>
          </Space>
        </Space>
      </Locations>
    </KNX>`;
    const model = parseEtsProject(xmlFile(xml));
    expect(model.communicationObjects.size).toBe(0);
    const fn = model.functions.get("FN-1");
    expect(fn?.name).toBe("Garage Light");
    expect(fn?.groupAddressIds).toEqual(["GA-1"]);
    const space = model.spaces.get(fn!.spaceId!);
    expect(space?.name).toBe("Garage");
  });

  it("resolves the project name from <ProjectInformation>", () => {
    const xml = `<KNX><ProjectInformation Name="Villa Rossi" /></KNX>`;
    const model = parseEtsProject(xmlFile(xml));
    expect(model.projectName).toBe("Villa Rossi");
  });
});
