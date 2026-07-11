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
    expect(device?.comObjectIds).toHaveLength(2);
    expect(device?.spaceId).toBeTruthy();

    const room = model.spaces.get(device!.spaceId!);
    expect(room?.name).toBe("Living Room");
    expect(room?.type).toBe("room");

    const switchObj = model.communicationObjects.get("O-1_R-1");
    expect(switchObj?.groupAddressIds).toEqual(["GA-1"]);
    expect(switchObj?.flags).toMatchObject({ write: true, communicate: true, transmit: false });

    const statusObj = model.communicationObjects.get("O-2_R-1");
    expect(statusObj?.flags).toMatchObject({ read: true, transmit: true, write: false });

    // The GA record itself was back-linked to its comm object.
    expect(model.groupAddresses.get("GA-1")?.comObjectIds).toEqual(["O-1_R-1"]);
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
