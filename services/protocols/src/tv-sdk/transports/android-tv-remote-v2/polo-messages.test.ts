import { describe, expect, it } from "vitest";
import { decodePoloMessage, encodeConfiguration, encodeOptions, encodePairingRequest, encodeSecret, STATUS_OK } from "./polo-messages.js";
import { decodeFields, encodeMessageField, encodeStringField, encodeVarintField, firstBytes, firstString, firstVarint } from "./protobuf-wire.js";

describe("polo-messages — OuterMessage envelope", () => {
  it("wraps every outgoing message with protocol_version=2 (matches upstream's runtime value, not the proto's unused default=1) and status=OK", () => {
    const buf = encodePairingRequest("SupremeOS", "SupremeOS");
    const fields = decodeFields(buf);
    expect(firstVarint(fields, 1)).toBe(2); // protocol_version
    expect(firstVarint(fields, 2)).toBe(STATUS_OK); // status
  });

  it("encodes PairingRequest with service_name and client_name", () => {
    const buf = encodePairingRequest("SvcName", "ClientName");
    const fields = decodeFields(buf);
    const reqBytes = firstBytes(fields, 10)!;
    const reqFields = decodeFields(reqBytes);
    expect(firstString(reqFields, 1)).toBe("SvcName");
    expect(firstString(reqFields, 2)).toBe("ClientName");
  });

  it("encodes Secret as a bytes field carrying the raw digest", () => {
    const digest = Buffer.from("deadbeef", "hex");
    const buf = encodeSecret(digest);
    const fields = decodeFields(buf);
    const secretBytes = firstBytes(fields, 40)!;
    const secretFields = decodeFields(secretBytes);
    expect(firstBytes(secretFields, 1)).toEqual(digest);
  });

  it("decodes a PairingRequestAck with a server_name", () => {
    // Hand-construct a minimal server response — this repo's client only ENCODES
    // PairingRequest/Options/Configuration (it never receives them), so there's no
    // existing encoder to reuse for a server-originated ack; build it directly instead.
    void encodeOptions;
    void encodeConfiguration;
    const ack = encodeMessageField(11, encodeStringField(1, "Living Room TV"));
    const outer = Buffer.concat([encodeVarintField(1, 1), encodeVarintField(2, STATUS_OK), ack]);
    const decoded = decodePoloMessage(outer);
    expect(decoded).toEqual({ type: "pairing-request-ack", serverName: "Living Room TV", status: STATUS_OK });
  });

  it("surfaces a non-OK status on any decoded message", () => {
    const outer = Buffer.concat([encodeVarintField(1, 1), encodeVarintField(2, 402)]); // STATUS_BAD_SECRET
    const decoded = decodePoloMessage(outer);
    expect(decoded.status).toBe(402);
  });
});
