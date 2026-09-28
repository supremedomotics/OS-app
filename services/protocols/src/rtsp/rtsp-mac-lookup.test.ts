import { describe, it, expect, vi, afterEach } from "vitest";

const readFileMock = vi.fn();
vi.mock("node:fs/promises", () => ({ readFile: (...args: unknown[]) => readFileMock(...args) }));

const { readArpTable } = await import("./rtsp-mac-lookup.js");

afterEach(() => {
  readFileMock.mockReset();
});

describe("readArpTable — best-effort MAC resolution", () => {
  it("parses /proc/net/arp entries with a resolved hardware address", async () => {
    readFileMock.mockResolvedValue(
      "IP address       HW type     Flags       HW address            Mask     Device\n" +
        "192.168.1.50     0x1         0x2         aa:bb:cc:dd:ee:ff     *        eth0\n" +
        "192.168.1.51     0x1         0x2         11:22:33:44:55:66     *        eth0\n",
    );
    const table = await readArpTable();
    expect(table.get("192.168.1.50")).toBe("aa:bb:cc:dd:ee:ff");
    expect(table.get("192.168.1.51")).toBe("11:22:33:44:55:66");
  });

  it("skips incomplete entries (flags 0x0) and the all-zero placeholder MAC", async () => {
    readFileMock.mockResolvedValue(
      "IP address       HW type     Flags       HW address            Mask     Device\n" +
        "192.168.1.52     0x1         0x0         00:00:00:00:00:00     *        eth0\n",
    );
    const table = await readArpTable();
    expect(table.has("192.168.1.52")).toBe(false);
  });

  it("skips malformed lines without throwing", async () => {
    readFileMock.mockResolvedValue("IP address\nnot a valid line at all\n192.168.1.53 bogus\n");
    const table = await readArpTable();
    expect(table.size).toBe(0);
  });

  it("resolves to an empty map (never throws) when the file is unreadable", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT: no such file or directory"));
    const table = await readArpTable();
    expect(table).toEqual(new Map());
  });

  it("resolves to an empty map when the read hangs past its timeout", async () => {
    readFileMock.mockImplementation(() => new Promise(() => {})); // never resolves
    const table = await readArpTable(10);
    expect(table).toEqual(new Map());
  });
});
