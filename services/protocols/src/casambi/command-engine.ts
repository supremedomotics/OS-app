import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";
import { commandToTargetControls } from "./entity-mapper.js";
import { CasambiFeedbackEngine } from "./feedback-engine.js";
import { localCommandToUdpPacket } from "./local-command-mapper.js";
import type { CasambiUdpEngine } from "./local-transport/index.js";

/**
 * Casambi Command Engine (§ Architecture Validation — mandatory pre-implementation audit). The
 * ONE seam every outgoing command passes through, regardless of which transport is active.
 * Before this module existed, `casambi-driver.ts`'s `command()` method contained an inline
 * `if (this.mode === "local")` branch that built and sent a command two structurally different
 * ways — a real violation of "every outgoing command passes through ONE command engine, no
 * protocol should create commands directly," found during the architecture audit (see
 * `docs/architecture/Casambi-Architecture-Audit.md`).
 *
 * `command()` now has exactly one call site — `this.commandEngine.send(...)` — and never
 * branches on connection mode itself; the mode decision happens exactly once, in the driver's
 * constructor, picking which `CasambiCommandEngine` implementation to hold. A hypothetical third
 * transport (the Lithernet gateway's "TCP Free Messages" mode, a future BLE mesh) adds a third
 * implementation of this SAME interface — never a new branch in the driver's business logic,
 * exactly the "Future support should allow REST/UDP/TCP/MQTT/BLE without changing business logic"
 * requirement.
 */
export interface CasambiCommandEngine {
  send(unitId: number, command: CapabilityCommand, prev: CapabilityState | null): Promise<void>;
}

/** Wraps the existing, unchanged Cloud command path — `entity-mapper.ts`'s
 * `commandToTargetControls` (resolves WHAT to send) + `CasambiFeedbackEngine` (writes it to the
 * live WebSocket wire). Identical calls, identical behavior to before this refactor — only the
 * call site moved, from inline in the driver to behind this interface. */
export class CloudCommandEngine implements CasambiCommandEngine {
  constructor(private readonly feedback: CasambiFeedbackEngine) {}

  async send(unitId: number, command: CapabilityCommand, prev: CapabilityState | null): Promise<void> {
    const targetControls = commandToTargetControls(command, prev);
    if (!targetControls) throw new Error(`casambi: unsupported command for ${command.capability}`);
    this.feedback.send(unitId, targetControls);
  }
}

/** Wraps the Local UDP command path — `local-command-mapper.ts`'s `localCommandToUdpPacket`
 * (resolves WHAT to send, the Local analogue of `commandToTargetControls`) + `CasambiUdpEngine`
 * (writes the encoded packet to the socket). */
export class LocalCommandEngine implements CasambiCommandEngine {
  constructor(
    private readonly udp: Pick<CasambiUdpEngine, "send">,
    private readonly netId: number,
  ) {}

  async send(unitId: number, command: CapabilityCommand, prev: CapabilityState | null): Promise<void> {
    const packet = localCommandToUdpPacket(this.netId, unitId, command, prev);
    if (!packet) throw new Error(`casambi: unsupported command for ${command.capability}`);
    // Some commands are genuinely a SEQUENCE, not one datagram — a curtain's Open/Close are
    // momentary on/off elements that need a press AND a release, exactly as the Casambi app
    // itself sends them (live-confirmed). Sent in order on the same socket.
    for (const p of Array.isArray(packet) ? packet : [packet]) await this.udp.send(p);
  }
}
