import { describe, expect, it } from "vitest";
import { decodeRemoteMessage, encodeRemoteConfigure, encodeRemoteKeyInject, encodeRemotePingResponse, encodeRemoteSetActive, RemoteFeature, SUPPORTED_FEATURES } from "./remote-messages.js";
import { REMOTE_KEY_CODES } from "./remote-key-codes.js";
import { encodeVarintField } from "./protobuf-wire.js";

describe("remote-messages — RemoteMessage envelope round trip", () => {
  it("round-trips RemoteConfigure with device info, masking code1 down to what this driver actually supports", () => {
    // PING|KEY|IME=7 — IME isn't in SUPPORTED_FEATURES, so it must be stripped from the reply.
    const buf = encodeRemoteConfigure(7, { model: "SupremeOS", vendor: "Supreme Domotics", packageName: "com.supremedomotics.supremeos", appVersion: "1.0.0" });
    const decoded = decodeRemoteMessage(buf);
    expect(decoded.type).toBe("remote-configure");
    if (decoded.type !== "remote-configure") throw new Error("unreachable");
    expect(decoded.code1).toBe(RemoteFeature.PING | RemoteFeature.KEY);
    expect(decoded.deviceInfo).toEqual({ model: "SupremeOS", vendor: "Supreme Domotics", packageName: "com.supremedomotics.supremeos", appVersion: "1.0.0" });
  });

  it("§2 RemoteConfigure.code1: never claims a feature the TV didn't advertise, even one this driver supports", () => {
    // TV only advertises PING — POWER/VOLUME/KEY (all otherwise supported) must not leak in.
    const decoded = decodeRemoteMessage(encodeRemoteConfigure(RemoteFeature.PING, { model: "", vendor: "", packageName: "", appVersion: "" }));
    if (decoded.type !== "remote-configure") throw new Error("unreachable");
    expect(decoded.code1).toBe(RemoteFeature.PING);
  });

  it("§2 RemoteConfigure.code1: never claims a feature this driver doesn't implement, even one the TV advertises", () => {
    // TV advertises everything, including IME/VOICE/APP_LINK/the unassigned bit — none of
    // those may appear in our reply since Phase 2 doesn't implement them.
    const everything = RemoteFeature.PING | RemoteFeature.KEY | RemoteFeature.IME | RemoteFeature.VOICE | RemoteFeature.UNKNOWN_1 | RemoteFeature.POWER | RemoteFeature.VOLUME | RemoteFeature.APP_LINK;
    const decoded = decodeRemoteMessage(encodeRemoteConfigure(everything, { model: "", vendor: "", packageName: "", appVersion: "" }));
    if (decoded.type !== "remote-configure") throw new Error("unreachable");
    expect(decoded.code1).toBe(SUPPORTED_FEATURES);
  });

  it("round-trips RemoteSetActive", () => {
    const decoded = decodeRemoteMessage(encodeRemoteSetActive(1));
    expect(decoded).toEqual({ type: "remote-set-active", active: 1 });
  });

  it("round-trips RemotePingResponse", () => {
    const decoded = decodeRemoteMessage(encodeRemotePingResponse(12345));
    expect(decoded).toEqual({ type: "remote-ping-response", val1: 12345 });
  });

  it("round-trips RemoteKeyInject for every mapped key with a SHORT direction", () => {
    for (const [key, code] of Object.entries(REMOTE_KEY_CODES)) {
      const decoded = decodeRemoteMessage(encodeRemoteKeyInject(code!));
      expect(decoded).toEqual({ type: "remote-key-inject", keyCode: code, direction: 3 });
      void key;
    }
  });

  it("an unrecognized envelope arm decodes as 'unknown' rather than throwing", () => {
    const decoded = decodeRemoteMessage(encodeVarintField(999, 1));
    expect(decoded.type).toBe("unknown");
  });
});
