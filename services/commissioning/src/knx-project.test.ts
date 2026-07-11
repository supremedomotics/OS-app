import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { addressFromInt, parseKnxProject, unzipKnxproj } from "./knx-project.js";

/** Minimal ZIP writer (deflate) so we can round-trip through the reader in-test. */
function makeZip(entries: { name: string; data: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const comp = deflateRawSync(Buffer.from(e.data, "utf8"));
    const uncompSize = Buffer.byteLength(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(uncompSize, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(uncompSize, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(cd, name);
    offset += lh.length + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const localBuf = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, cdBuf, eocd]);
}

const PROJECT_XML = `<?xml version="1.0"?>
<KNX>
  <GroupAddresses>
    <GroupRange Name="Lighting">
      <GroupAddress Id="GA-1" Address="2305" Name="Ceiling Switch" DatapointType="DPST-1-1" />
      <GroupAddress Id="GA-2" Address="2306" Name="Ceiling Dim" DatapointType="DPST-5-1" />
      <GroupAddress Id="GA-3" Address="4097" Name="Blind Position" DatapointType="DPST-5-1" />
    </GroupRange>
  </GroupAddresses>
  <Locations>
    <Space Type="Building" Name="Villa">
      <Space Type="Floor" Name="Ground">
        <Space Type="Room" Name="Living Room">
          <Function Type="FT-0" Name="Ceiling Light">
            <GroupAddressRef RefId="GA-1" />
            <GroupAddressRef RefId="GA-2" />
          </Function>
        </Space>
        <Space Type="Room" Name="Study">
          <Function Type="FT-1" Name="Blind">
            <GroupAddressRef RefId="GA-3" />
          </Function>
        </Space>
      </Space>
    </Space>
  </Locations>
</KNX>`;

describe("KNX .knxproj import", () => {
  it("converts a raw group-address integer to a 3-level address", () => {
    expect(addressFromInt(2305)).toBe("1/1/1");
    expect(addressFromInt(4097)).toBe("2/0/1");
  });

  it("round-trips through the zip reader and parses rooms, functions and capabilities", () => {
    const zip = makeZip([
      { name: "P-00AB/0.xml", data: PROJECT_XML },
      { name: "P-00AB/project.xml", data: "<Project/>" },
    ]);
    const { devices, addresses } = parseKnxProject(unzipKnxproj(zip));
    expect(addresses).toHaveLength(3);
    expect(addresses.every((a) => a.mainGroup === "Lighting")).toBe(true);

    const ceiling = devices.find((d) => d.name === "Ceiling Light");
    expect(ceiling?.room).toBe("Living Room");
    expect(new Set(ceiling?.bindings.map((b) => b.capability))).toEqual(new Set(["onoff", "brightness"]));
    expect(ceiling?.bindings.find((b) => b.capability === "onoff")?.address).toBe("1/1/1");

    const blind = devices.find((d) => d.name === "Blind");
    expect(blind?.room).toBe("Study");
    expect(blind?.bindings[0]?.capability).toBe("position");
  });

  it("captures nested Main + Middle Group names and infers a tunable-white colour circuit", () => {
    const xml = `<?xml version="1.0"?>
<KNX>
  <GroupAddresses>
    <GroupRange Name="Lighting">
      <GroupRange Name="Switching">
        <GroupAddress Id="GA-10" Address="1/4/1" Name="Study Downlight" DatapointType="DPST-1-1" />
      </GroupRange>
      <GroupRange Name="Relative Dimming">
        <GroupAddress Id="GA-11" Address="1/4/2" Name="Study Downlight" DatapointType="DPST-5-1" />
      </GroupRange>
      <GroupRange Name="Colour Temperature">
        <GroupAddress Id="GA-12" Address="1/4/3" Name="Study Downlight" DatapointType="DPST-7-600" />
      </GroupRange>
    </GroupRange>
  </GroupAddresses>
  <Locations>
    <Space Type="Building" Name="Villa">
      <Space Type="Room" Name="Study">
        <Function Type="FT-0" Name="Study Downlight">
          <GroupAddressRef RefId="GA-10" />
          <GroupAddressRef RefId="GA-11" />
          <GroupAddressRef RefId="GA-12" />
        </Function>
      </Space>
    </Space>
  </Locations>
</KNX>`;
    const zip = makeZip([{ name: "P-00CD/0.xml", data: xml }]);
    const { devices, addresses } = parseKnxProject(unzipKnxproj(zip));
    expect(addresses.find((a) => a.address === "1/4/3")).toMatchObject({ mainGroup: "Lighting", middleGroup: "Colour Temperature" });

    const downlight = devices.find((d) => d.name === "Study Downlight");
    expect(downlight?.room).toBe("Study");
    expect(new Set(downlight?.bindings.map((b) => b.capability))).toEqual(new Set(["onoff", "brightness", "color"]));
  });
});
