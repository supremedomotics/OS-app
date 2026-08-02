import { randomUUID } from "node:crypto";
import type { IEventBus, Subscription } from "@supreme/messaging";
import { handleRequests } from "../shared/rpc.js";
import {
  lanSubjects,
  type LanBindRequest,
  type LanBindResponse,
  type LanCloseRequest,
  type LanCloseResponse,
  type LanJoinMulticastRequest,
  type LanJoinMulticastResponse,
  type LanSendRequest,
  type LanSendResponse,
  type LanSessionDiagnostics,
} from "../shared/wire-types.js";
import { DgramUdpSession, defaultDgramSocket, type DgramSocketFactory } from "./dgram-udp-session.js";
import { diagnoseRouting } from "./routing-diagnosis.js";

/**
 * The `supreme-lan` server core (§ Production Architecture Refactor). Owns every real UDP socket
 * this process holds; NEVER contains protocol/business logic — it dispatches bind/send/close
 * commands from the NATS bus to a {@link DgramUdpSession} per session id, and republishes every
 * received datagram (decoded or not — decoding is not this layer's job) as a session-scoped event.
 * This is the process a driver's `NatsUdpTransportClient` is really talking to, whether that's
 * over `InProcessEventBus` (tests / a single-process dev stack) or a real `NatsEventBus` reaching
 * an actual `supreme-lan` container.
 */
export class UdpTransportServer {
  private readonly sessions = new Map<string, DgramUdpSession>();
  private subs: Subscription[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly socketFactory: DgramSocketFactory = defaultDgramSocket,
    /** § ENETUNREACH investigation — the deployment mode as EXPLICITLY configured
     * (`SUPREME_LAN_NETWORK_MODE`), never self-detected, so a send-failure diagnosis can name the
     * deployment shape honestly. Defaults to `"bridge"` because that is what the base
     * `docker-compose.yml` actually deploys. */
    private readonly networkMode: "bridge" | "host" | "macvlan" = "bridge",
  ) {}

  async start(): Promise<void> {
    this.subs.push(
      await handleRequests<LanBindRequest, LanBindResponse>(
        this.bus,
        lanSubjects.bind,
        async (req) => this.handleBind(req),
        (err) => ({ ok: false, error: err.message }),
      ),
    );
    this.subs.push(
      await handleRequests<LanSendRequest, LanSendResponse>(
        this.bus,
        lanSubjects.send,
        async (req) => this.handleSend(req),
        (err) => ({ ok: false, error: err.message }),
      ),
    );
    this.subs.push(
      await handleRequests<LanCloseRequest, LanCloseResponse>(
        this.bus,
        lanSubjects.close,
        async (req) => this.handleClose(req),
        () => ({ ok: true }), // close is best-effort — a double-close must never hang a caller
      ),
    );
    this.subs.push(
      await handleRequests<LanJoinMulticastRequest, LanJoinMulticastResponse>(
        this.bus,
        lanSubjects.joinMulticast,
        async (req) => this.handleJoinMulticast(req),
        (err) => ({ ok: false, error: err.message }),
      ),
    );
  }

  async stop(): Promise<void> {
    for (const sub of this.subs) sub.unsubscribe();
    this.subs = [];
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
    this.sessions.clear();
  }

  /** Real, non-fabricated per-session counters — the source `health.ts` reads from. */
  sessionDiagnostics(): LanSessionDiagnostics[] {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      localAddress: s.localAddress,
      localPort: s.localPort,
      multicastGroup: s.multicastGroup,
      packetsSent: s.packetsSent,
      packetsReceived: s.packetsReceived,
      lastError: s.lastError,
      joinedMulticastAt: s.joinedMulticastAt,
      joinedMulticastButNeverReceived: s.joinedMulticastButNeverReceived,
    }));
  }

  private async handleBind(req: LanBindRequest): Promise<LanBindResponse> {
    const sessionId = randomUUID();
    const session = new DgramUdpSession(sessionId, this.socketFactory);
    try {
      const addr = await session.bind(req.opts);
      session.multicastGroup = req.opts.multicastGroup ?? null;
      this.sessions.set(sessionId, session);
      session.onMessage((msg, rinfo) => {
        void this.bus.publish(lanSubjects.sessionRx(sessionId), {
          sessionId,
          dataBase64: msg.toString("base64"),
          rinfo,
          receivedAt: new Date().toISOString(),
        });
      });
      session.onError((err) => {
        void this.bus.publish(lanSubjects.sessionError(sessionId), {
          sessionId,
          message: err.message,
          at: new Date().toISOString(),
        });
      });
      await this.bus.publish(lanSubjects.sessionListening(sessionId), {
        sessionId,
        localAddress: addr.address,
        localPort: addr.port,
      });
      return { ok: true, sessionId, localAddress: addr.address, localPort: addr.port };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async handleSend(req: LanSendRequest): Promise<LanSendResponse> {
    const session = this.sessions.get(req.sessionId);
    if (!session) return { ok: false, error: `supreme-lan: unknown sessionId "${req.sessionId}"` };
    try {
      await session.send(Buffer.from(req.dataBase64, "base64"), req.port, req.host);
      return { ok: true };
    } catch (err) {
      // § ENETUNREACH investigation — attach a real routing diagnosis computed HERE, inside the
      // process that actually owns the socket and can see the real interfaces. The Gateway side
      // has no visibility into supreme-lan's network namespace, so this is the only place the
      // question "is there even a route to that address?" can be answered honestly.
      const code = (err as NodeJS.ErrnoException | undefined)?.code ?? null;
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        diagnosis: diagnoseRouting({ destination: req.host, errorCode: code, configuredNetworkMode: this.networkMode }),
      };
    }
  }

  private async handleJoinMulticast(req: LanJoinMulticastRequest): Promise<LanJoinMulticastResponse> {
    const session = this.sessions.get(req.sessionId);
    if (!session) return { ok: false, error: `supreme-lan: unknown sessionId "${req.sessionId}"` };
    try {
      await session.joinMulticast(req.group, req.iface);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async handleClose(req: LanCloseRequest): Promise<LanCloseResponse> {
    const session = this.sessions.get(req.sessionId);
    this.sessions.delete(req.sessionId);
    if (session) {
      await session.close();
      await this.bus.publish(lanSubjects.sessionClosed(req.sessionId), { sessionId: req.sessionId });
    }
    return { ok: true };
  }
}
