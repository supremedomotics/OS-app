import { describe, expect, it } from "vitest";
import {
  AGENT_LIMITS,
  AGENT_PROTOCOL_VERSION,
  agentMessageSemantics,
  isCompatibleProtocolMajor,
  parseAgentMessage,
  parseAgentMessageFromJson,
} from "./tv-agent-protocol.js";

function envelope(messageType: string, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentId: "agent-1",
    deviceId: "tv-1",
    messageId: "msg-1",
    timestamp: new Date().toISOString(),
    // Every message type except hello/pair requires an authenticated session — see
    // tv-agent-protocol.ts's MESSAGE_TYPES_WITHOUT_SESSION.
    ...(messageType === "hello" || messageType === "pair" ? {} : { sessionId: "session-1", sequenceNumber: 0 }),
    messageType,
    payload,
    ...overrides,
  };
}

describe("tv-agent-protocol — versioned envelope + message validation", () => {
  it("accepts a well-formed hello message", () => {
    const result = parseAgentMessage(envelope("hello", { agentVersion: "1.2.3" }));
    expect(result.ok).toBe(true);
  });

  it("rejects an unsupported protocolVersion, never silently coercing it", () => {
    const result = parseAgentMessage(envelope("hello", { agentVersion: "1.0.0" }, { protocolVersion: 999 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/protocolVersion/);
  });

  it("rejects a non-object message", () => {
    expect(parseAgentMessage("not an object").ok).toBe(false);
    expect(parseAgentMessage(null).ok).toBe(false);
    expect(parseAgentMessage(42).ok).toBe(false);
  });

  it("rejects a missing envelope field", () => {
    const msg = envelope("heartbeat", {});
    delete (msg as Record<string, unknown>).agentId;
    expect(parseAgentMessage(msg).ok).toBe(false);
  });

  it("rejects an unrecognized messageType", () => {
    const result = parseAgentMessage(envelope("not-a-real-type", {}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unrecognized messageType/);
  });

  it("rejects a payload of the wrong shape for a valid messageType", () => {
    const result = parseAgentMessage(envelope("volumeChanged", { volumePercent: "loud", muted: false }));
    expect(result.ok).toBe(false);
  });

  it("rejects volumePercent out of 0-100 range", () => {
    expect(parseAgentMessage(envelope("volumeChanged", { volumePercent: 150, muted: false })).ok).toBe(false);
    expect(parseAgentMessage(envelope("volumeChanged", { volumePercent: -1, muted: false })).ok).toBe(false);
    expect(parseAgentMessage(envelope("volumeChanged", { volumePercent: 100, muted: true })).ok).toBe(true);
  });

  it("accepts a well-formed mediaSession message with full metadata", () => {
    const result = parseAgentMessage(
      envelope("mediaSession", {
        packageName: "com.example.app",
        applicationName: "Example App",
        playbackState: "playing",
        playbackPositionMs: 125000,
        durationMs: 3600000,
        playbackSpeed: 1,
        title: "Example",
        displayTitle: null,
        subtitle: null,
        artist: "Example Artist",
        album: null,
        genre: null,
        mediaId: "123",
        mediaUri: null,
        artworkUri: null,
        queueTitle: null,
        supportedActions: ["play", "pause"],
        customActions: [],
        shuffle: null,
        repeat: null,
        confidence: "metadata",
        sessionRevision: 7,
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a mediaSession message with an invalid confidence value", () => {
    const result = parseAgentMessage(
      envelope("mediaSession", {
        packageName: "com.example.app",
        applicationName: null,
        playbackState: "playing",
        playbackPositionMs: null,
        durationMs: null,
        playbackSpeed: null,
        title: null,
        displayTitle: null,
        subtitle: null,
        artist: null,
        album: null,
        genre: null,
        mediaId: null,
        mediaUri: null,
        artworkUri: null,
        queueTitle: null,
        supportedActions: [],
        customActions: [],
        shuffle: null,
        repeat: null,
        confidence: "definitely_certain", // not a real value — must never be inferred/invented
        sessionRevision: null,
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("accepts appInventory with an arbitrary package name (never hardcoded to major streaming apps)", () => {
    const result = parseAgentMessage(
      envelope("appInventory", {
        apps: [{ packageName: "com.some.obscure.regional.app", applicationName: "Obscure App", version: "2.0", launchable: true, installed: true }],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects goodbye/error with the wrong payload shape", () => {
    expect(parseAgentMessage(envelope("goodbye", { reason: 42 })).ok).toBe(false);
    expect(parseAgentMessage(envelope("error", { code: "", message: "x" })).ok).toBe(false);
    expect(parseAgentMessage(envelope("error", { code: "E1", message: "x" })).ok).toBe(true);
  });

  describe("§4 replay/session protection — sessionId + sequenceNumber", () => {
    it("hello and pair may omit sessionId/sequenceNumber (no session exists yet)", () => {
      expect(parseAgentMessage(envelope("hello", { agentVersion: "1.0.0" })).ok).toBe(true);
      expect(parseAgentMessage(envelope("pair", { pairingCode: "abc123" })).ok).toBe(true);
    });

    it("every other message type requires both sessionId and sequenceNumber", () => {
      const withoutSession = envelope("heartbeat", {});
      delete (withoutSession as Record<string, unknown>).sessionId;
      expect(parseAgentMessage(withoutSession).ok).toBe(false);

      const withoutSequence = envelope("heartbeat", {});
      delete (withoutSequence as Record<string, unknown>).sequenceNumber;
      expect(parseAgentMessage(withoutSequence).ok).toBe(false);
    });

    it("rejects a negative or non-integer sequenceNumber", () => {
      expect(parseAgentMessage(envelope("heartbeat", {}, { sequenceNumber: -1 })).ok).toBe(false);
      expect(parseAgentMessage(envelope("heartbeat", {}, { sequenceNumber: 1.5 })).ok).toBe(false);
      expect(parseAgentMessage(envelope("heartbeat", {}, { sequenceNumber: 0 })).ok).toBe(true);
    });
  });

  describe("§5 protocol version negotiation", () => {
    it("isCompatibleProtocolMajor accepts only the exact major this build speaks", () => {
      expect(isCompatibleProtocolMajor(AGENT_PROTOCOL_VERSION)).toBe(true);
      expect(isCompatibleProtocolMajor(AGENT_PROTOCOL_VERSION + 1)).toBe(false);
      expect(isCompatibleProtocolMajor(0)).toBe(false);
    });

    it("an unrecognized protocolMinor never blocks acceptance — minor differences are always tolerated", () => {
      const result = parseAgentMessage(envelope("heartbeat", {}, { protocolMinor: 999 }));
      expect(result.ok).toBe(true);
    });

    it("a major-version mismatch fails safely rather than being coerced", () => {
      const result = parseAgentMessage(envelope("heartbeat", {}, { protocolVersion: AGENT_PROTOCOL_VERSION + 1 }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/incompatible protocolVersion/);
    });

    it("rejects a non-integer or negative protocolMinor", () => {
      expect(parseAgentMessage(envelope("heartbeat", {}, { protocolMinor: -1 })).ok).toBe(false);
      expect(parseAgentMessage(envelope("heartbeat", {}, { protocolMinor: 1.5 })).ok).toBe(false);
    });
  });

  describe("§6 message size limits — same defensive discipline as Remote v2 framing", () => {
    it("parseAgentMessageFromJson rejects an oversized message before ever calling JSON.parse", () => {
      const huge = "x".repeat(AGENT_LIMITS.maxMessageBytes + 1);
      const result = parseAgentMessageFromJson(huge);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/exceeds maxMessageBytes/);
    });

    it("parseAgentMessageFromJson accepts a well-formed message at or under the byte limit", () => {
      const json = JSON.stringify(envelope("heartbeat", {}));
      expect(parseAgentMessageFromJson(json).ok).toBe(true);
    });

    it("parseAgentMessageFromJson reports invalid JSON distinctly from a schema failure", () => {
      const result = parseAgentMessageFromJson("{not valid json");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/invalid JSON/);
    });

    it("rejects a metadata field (e.g. title) beyond maxMetadataFieldLength", () => {
      const base = {
        packageName: "com.example.app",
        applicationName: null,
        playbackState: "playing",
        playbackPositionMs: null,
        durationMs: null,
        playbackSpeed: null,
        title: "x".repeat(AGENT_LIMITS.maxMetadataFieldLength + 1),
        displayTitle: null,
        subtitle: null,
        artist: null,
        album: null,
        genre: null,
        mediaId: null,
        mediaUri: null,
        artworkUri: null,
        queueTitle: null,
        supportedActions: [],
        customActions: [],
        shuffle: null,
        repeat: null,
        confidence: "metadata",
        sessionRevision: null,
      };
      const result = parseAgentMessage(envelope("mediaSession", base));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/title exceeds maximum length/);
    });

    it("rejects an appInventory array beyond maxAppInventoryEntries", () => {
      const apps = Array.from({ length: AGENT_LIMITS.maxAppInventoryEntries + 1 }, (_, i) => ({
        packageName: `com.example.app${i}`,
        applicationName: null,
        version: null,
        launchable: true,
        installed: true,
      }));
      const result = parseAgentMessage(envelope("appInventory", { apps }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/exceeds maximum entries/);
    });

    it("rejects a package/application name beyond its max length even at legal array size", () => {
      const result = parseAgentMessage(
        envelope("appInventory", {
          apps: [{ packageName: "x".repeat(AGENT_LIMITS.maxPackageNameLength + 1), applicationName: null, version: null, launchable: true, installed: true }],
        }),
      );
      expect(result.ok).toBe(false);
    });

    it("rejects supportedActions/customActions arrays beyond their entry limits", () => {
      const oversized = Array.from({ length: AGENT_LIMITS.maxSupportedActionsEntries + 1 }, (_, i) => `action_${i}`);
      const result = parseAgentMessage(envelope("mediaCapabilitiesChanged", { supportedActions: oversized, customActions: [] }));
      expect(result.ok).toBe(false);
    });
  });

  describe("§9 message semantics — snapshot/delta/notification/request/response classification", () => {
    it("classifies every message type exactly once, matching the documented model", () => {
      expect(agentMessageSemantics("hello")).toBe("request");
      expect(agentMessageSemantics("pair")).toBe("request");
      expect(agentMessageSemantics("authenticated")).toBe("response");
      expect(agentMessageSemantics("heartbeat")).toBe("request");
      expect(agentMessageSemantics("deviceInfo")).toBe("snapshot");
      expect(agentMessageSemantics("appInventory")).toBe("snapshot");
      expect(agentMessageSemantics("mediaSession")).toBe("snapshot");
      expect(agentMessageSemantics("foregroundApp")).toBe("notification");
      expect(agentMessageSemantics("mediaStateChanged")).toBe("delta");
      expect(agentMessageSemantics("mediaMetadataChanged")).toBe("delta");
      expect(agentMessageSemantics("mediaCapabilitiesChanged")).toBe("delta");
      expect(agentMessageSemantics("volumeChanged")).toBe("notification");
      expect(agentMessageSemantics("error")).toBe("notification");
      expect(agentMessageSemantics("goodbye")).toBe("notification");
    });
  });
});
