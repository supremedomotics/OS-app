import { describe, expect, it, vi } from "vitest";
import { DeviceError, DeviceRegistry, InMemoryDeviceStore } from "./index.js";

const T0 = 1_750_000_000_000;
function clock() {
  let t = T0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("DeviceRegistry — lifecycle", () => {
  it("registers, lists, and renames a device", () => {
    const reg = new DeviceRegistry({ now: clock().now, store: new InMemoryDeviceStore() });
    const d = reg.register({ accountId: "a1", name: "Mujeeb's iPhone", platform: "ios", model: "iPhone 16 Pro" });
    expect(d.trust).toBe("approved"); // first device on the account
    expect(reg.list("a1")).toHaveLength(1);

    const renamed = reg.rename("a1", d.id, "Mujeeb iPhone 16");
    expect(renamed.name).toBe("Mujeeb iPhone 16");
  });

  it("requires approval for additional devices when policy is on", () => {
    const reg = new DeviceRegistry({ approveNewDevices: true, now: clock().now });
    reg.register({ accountId: "a1", name: "iPhone", platform: "ios" }); // first → approved
    const second = reg.register({ accountId: "a1", name: "Office Tablet", platform: "android" });
    expect(second.trust).toBe("pending");
    expect(reg.approve("a1", second.id).trust).toBe("approved");
  });

  it("won't let one account manage another's device", () => {
    const reg = new DeviceRegistry();
    const d = reg.register({ accountId: "a1", name: "iPhone", platform: "ios" });
    expect(() => reg.rename("intruder", d.id, "x")).toThrow(DeviceError);
    expect(() => reg.remove("intruder", d.id)).toThrow(/another account/);
  });
});

describe("DeviceRegistry — remote logout & delete revoke sessions", () => {
  it("remote logout revokes the device's auth session", () => {
    const revokeSession = vi.fn();
    const reg = new DeviceRegistry({ revokeSession, now: clock().now });
    const d = reg.register({ accountId: "a1", name: "iPhone", platform: "ios", sessionId: "sess-9" });

    const out = reg.remoteLogout("a1", d.id);
    expect(out.trust).toBe("revoked");
    expect(out.sessionId).toBeNull();
    expect(revokeSession).toHaveBeenCalledWith("sess-9");
  });

  it("delete revokes the session and removes the record", () => {
    const revokeSession = vi.fn();
    const reg = new DeviceRegistry({ revokeSession });
    const d = reg.register({ accountId: "a1", name: "Old phone", platform: "android", sessionId: "sess-7" });
    reg.remove("a1", d.id);
    expect(revokeSession).toHaveBeenCalledWith("sess-7");
    expect(reg.list("a1")).toHaveLength(0);
  });
});

describe("DeviceRegistry — phone replacement", () => {
  it("registers a new phone and optionally revokes the old one", () => {
    const revokeSession = vi.fn();
    const c = clock();
    const reg = new DeviceRegistry({ revokeSession, now: c.now });
    const oldPhone = reg.register({ accountId: "a1", name: "iPhone 14", platform: "ios", sessionId: "sess-old" });

    c.advance(86_400_000); // a year-later upgrade…
    const newPhone = reg.register({ accountId: "a1", name: "iPhone 16 Pro", platform: "ios", sessionId: "sess-new" });
    expect(newPhone.trust).toBe("approved"); // logged-in account, not first-ever → still trusted by default policy
    expect(reg.list("a1").map((d) => d.name)).toEqual(["iPhone 16 Pro", "iPhone 14"]);

    // User chooses to revoke the old device.
    reg.remoteLogout("a1", oldPhone.id);
    expect(revokeSession).toHaveBeenCalledWith("sess-old");
  });
});

describe("DeviceRegistry — presence", () => {
  it("touch updates last-seen metadata", () => {
    const c = clock();
    const reg = new DeviceRegistry({ now: c.now });
    const d = reg.register({ accountId: "a1", name: "Panel", platform: "panel" });
    c.advance(5000);
    reg.touch(d.id, { ip: "10.0.0.5", geo: "Mumbai, IN" });
    const got = reg.list("a1")[0]!;
    expect(got.lastSeenAt).toBe(T0 + 5000);
    expect(got.lastIp).toBe("10.0.0.5");
    expect(got.lastGeo).toBe("Mumbai, IN");
  });
});
