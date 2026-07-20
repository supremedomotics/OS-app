# AV Adapter Development Guide

> How to build a new AV protocol adapter against the [Universal AV SDK](./Universal-AV-SDK.md).
> Written from `services/protocols/src/av-sdk/extensibility.test.ts` — a real, compiling,
> passing proof that the SDK's public surface is sufficient for a from-scratch adapter, not a
> theoretical description. That file is a **synthetic, fake, non-real brand** (no manifest,
> not exported from `index.ts`, not registered anywhere) — built solely to prove the seam
> works, per the explicit instruction not to create placeholder adapters for brands with no
> real protocol implementation. When a **real** new brand's protocol research begins, this
> guide — not the fake test file — is what a driver author should follow.

## The adapter contract

Every AV driver implements `INativeProtocolDriver`
(`services/integration-layer/src/protocols/driver.ts`) — the same interface every
driver in the 22-driver fleet implements, not an AV-specific contract:

```ts
interface INativeProtocolDriver {
  readonly protocol: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  bind(binding: ProtocolBinding): Promise<void>;
  manages(deviceId: DeviceId): boolean;
  command(deviceId: DeviceId, command: CapabilityCommand): Promise<void>;
  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null;
  discover(): Promise<DiscoveredDevice[]>;
  onState(listener: StateListener): () => void;
  // Optional, implement what you can genuinely support:
  getArtwork?(deviceId: DeviceId): Promise<ArtworkResult | null>;
  getQueue?(deviceId: DeviceId): Promise<MediaQueueItem[] | null>;
  getCapabilityConfig?(deviceId: DeviceId, capability: CapabilityKind): Record<string, unknown> | null;
  getDiagnostics?(deviceId: DeviceId): DriverDiagnosticsSnapshot | null;
  unbind?(deviceId: DeviceId): Promise<void>;
}
```

See [Driver-SDK.md](./Driver-SDK.md) and [Driver-Lifecycle.md](./Driver-Lifecycle.md)
for the full fleet-wide contract (they predate and apply beyond AV specifically —
`unbind()`'s idempotency/shared-resource-release rules, the 20-state lifecycle,
etc.). This guide only covers what's specific to building an AV adapter on top of
the transport primitives.

## Step 1 — does your protocol need `TcpLineTransport`?

Ask: **is this a persistent TCP socket, speaking a line-delimited text protocol?**

| If yes (Denon/Marantz Telnet-shaped, HEOS-CLI-shaped) | If no (Yamaha-HTTP-shaped) |
|---|---|
| Use `TcpLineTransport` — see Step 2 | Don't force it. Write your own transport code, matching whatever the real protocol needs (HTTP client, UDP listener, WebSocket, etc.) — see [Universal-AV-SDK.md](./Universal-AV-SDK.md)'s "Yamaha: thinner, not thin" section for why this is correct, not a gap. If a THIRD driver later needs the same non-TCP transport shape Yamaha uses, THAT'S the evidence to extract a second SDK primitive — not before. |

## Step 2 — wire up `TcpLineTransport`

```ts
import { TcpLineTransport, type TcpLink } from "./av-sdk/tcp-line-transport.js";

export class MyBrandProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "mybrand";
  private connected = false;
  private readonly bindings: MyBrandBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();
  private readonly transport: TcpLineTransport;

  constructor(opts: MyBrandDriverOptions = {}) {
    this.transport = new TcpLineTransport({
      delimiter: "\r\n", // whatever YOUR protocol's line terminator actually is
      reconnectBaseMs: opts.reconnectBaseMs,
      reconnectMaxMs: opts.reconnectMaxMs,
      createSocket: opts.createSocket, // pass through for testability
      onLog: opts.onLog,
      onConnect: (link, socket, host, port) => this.onLinkConnect(link, socket, host, port),
      onLine: (ctx, line) => this.onLine(ctx.host, ctx.port, line), // or ctx.link, if you need it
    });
  }

  private onLinkConnect(link: TcpLink, socket: net.Socket, host: string, port: number): void {
    // YOUR protocol's init-command sequence. Record each via link.diagnostics.recordSend(...).
    socket.write("QUERY_STATE\r\n");
  }

  private onLine(host: string, port: number, line: string): void {
    // Parse YOUR protocol's line format into a discrete update, then call
    // recordCapabilityState(...) for whichever device/capability it belongs to.
  }
}
```

## Step 3 — wire up `recordCapabilityState`

```ts
import { recordCapabilityState } from "./av-sdk/state-cache.js";

private record(deviceId: DeviceId, capability: CapabilityKind, state: CapabilityState): void {
  recordCapabilityState(this.states, this.listeners, deviceId, capability, state);
}
```

This replaces what would otherwise be a hand-written dedupe-and-dispatch method —
literally the same 6 lines every existing AV driver used to duplicate.

## Step 4 — everything else is genuinely protocol-specific, and stays yours

The SDK does not, and should not, try to generalize:

- **`bind()`/`unbind()`** — your own binding bookkeeping (`this.bindings`), plus
  calling `this.transport.ensureLink(key, host, port)` when connected, and
  `this.transport.releaseKey(key)` once your own "is this key still referenced by
  another device" check says it's orphaned (the transport has no visibility into
  your bindings — that check is always yours, never the SDK's).
- **`command()`** — encode a `CapabilityCommand` into YOUR protocol's wire format,
  write it via `this.transport.ensureLink(key, host, port).socket`.
- **Response/event parsing** — YOUR protocol's line/message format into a
  discriminated update type, exactly like `avr-codec.ts`'s `parseAvrLine()` or
  `heos-codec.ts`'s `parseHeosMessage()`. There is no shared parser, because there
  is no shared wire format — Denon Telnet ASCII tokens, HEOS `heos://` URI-style
  messages, and (if you're not using `TcpLineTransport`) Yamaha's JSON-over-HTTP
  are fundamentally incompatible, and a "universal AV wire parser" would be a
  fabricated abstraction with nothing real underneath it.
- **Zone/player/device addressing** — however your protocol identifies which
  physical thing a command targets (a zone enum, an opaque player id, a serial
  number — whatever the wire protocol actually gives you). See
  [Automation-Editor-Future-Driver-SDK-Roadmap.md](./Automation-Editor-Future-Driver-SDK-Roadmap.md)'s
  maturity model if you're wondering how this could eventually feed a richer
  authoring UI — that's future, unimplemented work, not something this SDK
  provides today.
- **`getCapabilityConfig()`** — if your protocol can report real structural
  capability info (volume ranges, zone lists, sound modes — whatever's genuinely
  queryable), implement it returning your own shape (see `avr-capabilities.ts`'s
  `AudioCapabilityConfig`, already shared across all three existing AV drivers'
  codecs). If it can't be queried, don't implement it — a missing optional method
  is honest; a fabricated one isn't.
- **`getDiagnostics()`** — call `this.transport.diagnosticsFor(key)` for the
  status + counters, then build your own `info` object (`model`/`firmware`/`ip`/
  `mac`) from whatever your protocol actually exposes. Fields your protocol can't
  report stay `null` — never guessed.

## Adding a real new AV brand — the actual process

1. **Protocol research first.** Get the vendor's real IP-control spec (Telnet
   command reference, HTTP API docs, whatever exists). Confirm whether it's a
   persistent line-delimited TCP protocol (→ use `TcpLineTransport`) or something
   else (→ don't force it).
2. **Write the codec first, test it in isolation.** A pure `command → wire` /
   `wire → update` pair, unit-tested with no network at all — see `avr-codec.ts`'s
   or `heos-codec.ts`'s test files for the pattern. This is almost always most of
   the real work; the transport wiring in Step 2 is comparatively small.
3. **Wire the driver class** per Steps 2–4 above, against a **real embedded
   server** in tests (a real `net.createServer` speaking your protocol's actual
   line format, matching every existing driver test in this fleet) — never a mock
   of the transport itself.
4. **Add the manifest** (`services/drivers/src/manifests.ts`) and register the
   factory (`services/gateway/src/native-driver-factory.ts`) — the same mechanical
   steps every existing driver already follows; nothing AV-specific here either.
5. **Do not add your brand to `ProtocolKind`'s enum speculatively** before the
   driver exists — that enum (`packages/domain-model/src/drivers.ts`) should only
   ever contain protocols with a real, working implementation behind them.

**What you will NOT need to touch:** `TcpLineTransport`, `recordCapabilityState`,
or any other existing AV driver. If building your adapter ever seems to require
changing SDK internals, that's a signal either (a) your protocol's shape doesn't
fit `TcpLineTransport` and you should write your own transport instead (see Step
1), or (b) you've found a genuine second instance of some duplicated logic — in
which case, extract it the same evidence-based way this SDK itself was built:
confirm the duplication is real before generalizing, don't extrapolate from one
example.
