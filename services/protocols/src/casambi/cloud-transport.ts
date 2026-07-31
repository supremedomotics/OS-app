import type { CasambiUnit } from "./entity-mapper.js";

/**
 * Casambi transport seam (§3, §7) — the ONLY place that speaks to Casambi Cloud over the wire.
 * REST (https://door.casambi.com) provides the persistent network/unit/group model; the WebSocket
 * (wss://door.casambi.com/v1/bridge/) streams live unit state and carries control messages. The
 * driver depends only on these interfaces, so no HTTP/WS detail leaks above it and the driver can be
 * unit-tested against an in-memory fake. Credentials (API key, e-mail, password, session id) live in
 * the transport instance and are NEVER placed in log output or error messages.
 */

const CASAMBI_REST = "https://door.casambi.com";
const CASAMBI_WS = "wss://door.casambi.com/v1/bridge/";

/** Credentials for a Casambi network (admin) session. */
export interface CasambiCredentials {
  /** WebSocket-enabled API key (X-Casambi-Key). */
  apiKey: string;
  /** Network admin e-mail. */
  email: string;
  /** Network admin password. */
  password: string;
  /** Optional network entity id — when set, the faster per-network session endpoint is used. */
  networkId?: string;
}

/** An authenticated session bound to a single Casambi network. */
export interface CasambiSession {
  sessionId: string;
  networkId: string;
  networkName?: string;
}

/** A Casambi group (used to auto-map luminaires to Supreme rooms by the group's name). */
export interface CasambiGroup {
  id: number;
  name?: string;
  /** Ids of the units that belong to this group. */
  units: number[];
}

/** The persistent network model fetched over REST. */
export interface CasambiNetwork {
  units: CasambiUnit[];
  groups: CasambiGroup[];
}

/** A parsed Casambi WebSocket event/response message. */
export interface CasambiEvent {
  method?: string;
  wire?: number;
  wireStatus?: string;
  response?: string;
  ref?: string;
  id?: number;
  /** Present on unitChanged; the changed unit's state fields. */
  [key: string]: unknown;
}

/** Handlers wired to a WebSocket before/at connect. */
export interface CasambiWireHandlers {
  onEvent: (event: CasambiEvent) => void;
  onClose: () => void;
  onError: (error: unknown) => void;
}

/**
 * A live Casambi WebSocket wire. All Casambi message framing (open/ping/controlUnit) lives here so
 * the driver only expresses intent. `wire` is the integer connection id from the OPEN message.
 */
export interface CasambiWire {
  /** Bind a session+network to the given wire id (the mandatory first message after connect). */
  open(session: CasambiSession, wire: number): void;
  /** Keep-alive ping for a wire (server replies `{"response":"pong"}`). */
  ping(wire: number): void;
  /** Send a `controlUnit` with the codec-built `targetControls`. */
  controlUnit(wire: number, unitId: number, targetControls: Record<string, unknown>): void;
  /** Close the underlying socket. */
  close(): void;
  /** True while the socket is open. */
  readonly connected: boolean;
}

export interface CasambiTransport {
  /** Create a network (admin) session; requires a valid API key + credentials. */
  createSession(creds: CasambiCredentials): Promise<CasambiSession>;
  /** Fetch the persistent network model (units + groups) for a session. */
  fetchNetwork(session: CasambiSession): Promise<CasambiNetwork>;
  /** Fetch the current state of every unit in the network. */
  fetchState(session: CasambiSession): Promise<CasambiUnit[]>;
  /** Open a WebSocket wire (API key is sent as the WS subprotocol). Resolves once the socket opens. */
  openWire(handlers: CasambiWireHandlers): Promise<CasambiWire>;
}

/** Minimal structural view of a WebSocket (global `WebSocket` in Node ≥ 21, or `ws`). */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  readyState: number;
  addEventListener(type: "open", cb: () => void): void;
  addEventListener(type: "close", cb: () => void): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
}

/** Factory that opens a raw WebSocket with the API key as its subprotocol. Injectable for tests. */
export type CasambiSocketFactory = (url: string, apiKey: string) => WebSocketLike;

const defaultSocketFactory: CasambiSocketFactory = (url, apiKey) =>
  new WebSocket(url, apiKey) as unknown as WebSocketLike;

export interface HttpCasambiTransportOptions {
  apiKey: string;
  /** REST base (default https://door.casambi.com). */
  restBase?: string;
  /** WebSocket URL (default wss://door.casambi.com/v1/bridge/). */
  wsUrl?: string;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Injectable WebSocket factory (tests). */
  socketFactory?: CasambiSocketFactory;
}

/**
 * Real Casambi transport over documented Cloud HTTP + WebSocket. The API key is held privately and
 * only ever travels in the `X-Casambi-Key` header / WS subprotocol — never in thrown errors or logs.
 */
export class HttpCasambiTransport implements CasambiTransport {
  private readonly apiKey: string;
  private readonly restBase: string;
  private readonly wsUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly socketFactory: CasambiSocketFactory;

  constructor(opts: HttpCasambiTransportOptions) {
    this.apiKey = opts.apiKey;
    this.restBase = (opts.restBase ?? CASAMBI_REST).replace(/\/$/, "");
    this.wsUrl = opts.wsUrl ?? CASAMBI_WS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.socketFactory = opts.socketFactory ?? defaultSocketFactory;
  }

  async createSession(creds: CasambiCredentials): Promise<CasambiSession> {
    const path = creds.networkId
      ? `/v1/networks/${encodeURIComponent(creds.networkId)}/session`
      : "/v1/networks/session";
    const res = await this.fetchImpl(`${this.restBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Casambi-Key": this.apiKey },
      body: JSON.stringify({ email: creds.email, password: creds.password }),
    });
    if (!res.ok) throw new Error(`casambi: session request failed (HTTP ${res.status})`);
    const body = (await res.json()) as Record<string, unknown>;
    return parseSession(body, creds.networkId);
  }

  async fetchNetwork(session: CasambiSession): Promise<CasambiNetwork> {
    const body = (await this.get(session, `/v1/networks/${encodeURIComponent(session.networkId)}`)) as {
      units?: unknown;
      groups?: unknown;
    };
    return { units: parseUnits(body.units), groups: parseGroups(body.groups) };
  }

  async fetchState(session: CasambiSession): Promise<CasambiUnit[]> {
    const body = (await this.get(session, `/v1/networks/${encodeURIComponent(session.networkId)}/state`)) as {
      units?: unknown;
    };
    return parseUnits(body.units);
  }

  async openWire(handlers: CasambiWireHandlers): Promise<CasambiWire> {
    const socket = this.socketFactory(this.wsUrl, this.apiKey);
    return await new Promise<CasambiWire>((resolve, reject) => {
      let opened = false;
      socket.addEventListener("open", () => {
        opened = true;
        resolve(makeWire(socket));
      });
      socket.addEventListener("message", (ev) => {
        void decodeMessage(ev.data).then((event) => {
          if (event) handlers.onEvent(event);
        });
      });
      socket.addEventListener("close", () => {
        if (!opened) reject(new Error("casambi: WebSocket closed before opening"));
        handlers.onClose();
      });
      socket.addEventListener("error", (err) => {
        if (!opened) reject(new Error("casambi: WebSocket error before opening"));
        handlers.onError(err);
      });
    });
  }

  private async get(session: CasambiSession, path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.restBase}${path}`, {
      headers: { "X-Casambi-Key": this.apiKey, "X-Casambi-Session": session.sessionId },
    });
    if (res.status === 410) throw new CasambiSessionExpiredError();
    if (!res.ok) throw new Error(`casambi: GET ${path} failed (HTTP ${res.status})`);
    return res.json();
  }
}

/** Thrown on HTTP 410 (invalid/expired session) so the driver knows to re-authenticate. */
export class CasambiSessionExpiredError extends Error {
  constructor() {
    super("casambi: session expired");
    this.name = "CasambiSessionExpiredError";
  }
}

function makeWire(socket: WebSocketLike): CasambiWire {
  const send = (msg: Record<string, unknown>): void => {
    if (socket.readyState === 1) socket.send(JSON.stringify(msg));
  };
  return {
    open(session, wire) {
      send({ method: "open", id: session.networkId, session: session.sessionId, ref: `w${wire}`, wire, type: 1 });
    },
    ping(wire) {
      send({ method: "ping", wire });
    },
    controlUnit(wire, unitId, targetControls) {
      send({ wire, method: "controlUnit", id: unitId, targetControls });
    },
    close() {
      try {
        socket.close();
      } catch {
        // already closing/closed
      }
    },
    get connected() {
      return socket.readyState === 1;
    },
  };
}

/** WebSocket frames may arrive as string, Blob, ArrayBuffer, or Buffer — normalize then JSON-parse. */
async function decodeMessage(data: unknown): Promise<CasambiEvent | null> {
  try {
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof Uint8Array) text = Buffer.from(data).toString("utf8");
    else if (data instanceof ArrayBuffer) text = Buffer.from(new Uint8Array(data)).toString("utf8");
    else if (typeof (data as Blob)?.text === "function") text = await (data as Blob).text();
    else text = String(data);
    return JSON.parse(text) as CasambiEvent;
  } catch {
    return null;
  }
}

function parseSession(body: Record<string, unknown>, networkId?: string): CasambiSession {
  // Per-network endpoint returns a flat object; /networks/session returns a map keyed by network id.
  if (typeof body.sessionId === "string") {
    const id = typeof body.id === "string" ? body.id : networkId ?? String(body.id ?? "");
    return { sessionId: body.sessionId, networkId: id, networkName: strOrUndef(body.name) };
  }
  const entries = Object.values(body).filter(
    (v): v is Record<string, unknown> => !!v && typeof v === "object",
  );
  const chosen =
    (networkId && entries.find((e) => String(e.id ?? "") === networkId)) ?? entries[0];
  if (!chosen || typeof chosen.sessionId !== "string") {
    throw new Error("casambi: session response did not contain a sessionId");
  }
  return {
    sessionId: chosen.sessionId,
    networkId: typeof chosen.id === "string" ? chosen.id : networkId ?? String(chosen.id ?? ""),
    networkName: strOrUndef(chosen.name),
  };
}

function parseUnits(raw: unknown): CasambiUnit[] {
  const list = toArray(raw);
  return list
    .filter((u): u is Record<string, unknown> => !!u && typeof u === "object")
    .map((u) => ({
      id: Number(u.id),
      name: strOrUndef(u.name),
      type: strOrUndef(u.type),
      fixtureId: numOrUndef(u.fixtureId),
      groupId: numOrUndef(u.groupId),
      address: strOrUndef(u.address),
      online: typeof u.online === "boolean" ? u.online : undefined,
      on: typeof u.on === "boolean" ? u.on : undefined,
      dimLevel: numOrUndef(u.dimLevel),
      status: strOrUndef(u.status),
      condition: numOrUndef(u.condition),
      activeSceneId: numOrUndef(u.activeSceneId),
      controls: Array.isArray(u.controls) ? (u.controls as CasambiUnit["controls"]) : undefined,
      sensors: u.sensors && typeof u.sensors === "object" ? (u.sensors as Record<string, unknown>) : undefined,
      image: strOrUndef(u.image),
    }))
    .filter((u) => Number.isFinite(u.id));
}

function parseGroups(raw: unknown): CasambiGroup[] {
  const list = toArray(raw);
  return list
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
    .map((g) => ({
      id: Number(g.id),
      name: strOrUndef(g.name),
      units: toArray(g.units)
        .map((u) => (typeof u === "object" && u ? Number((u as { id?: unknown }).id) : Number(u)))
        .filter((n) => Number.isFinite(n)),
    }))
    .filter((g) => Number.isFinite(g.id));
}

/** Casambi collections arrive either as arrays or as objects keyed by id — normalize to an array. */
function toArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return Object.values(raw as Record<string, unknown>);
  return [];
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
