# KNX reconnect ownership — who connects, who retries, who cancels

2026-10-18 · Stage 1 of the native group-communication milestone · **Implemented and simulator-tested; nothing here is wired into production and no hardware was involved.**
Code: `services/protocols/src/knx/native/supervised-tunnel.ts`, `knx-connection.ts`, `single-slot.ts`; fix to `health/health-service.ts`.
Tests: `supervised-tunnel.test.ts` (5), `knx-connection.test.ts` (lifecycle/recovery groups), `single-slot.test.ts` (3), `health/health-service-lifecycle.test.ts` (2).

## 1. Inventory (read from the code, not assumed)

Everything that can start, repeat or cancel a KNX connection attempt today:

| # | Caller | Where | What it does to the KNX driver |
|---|---|---|---|
| C1 | Hub boot | `integration-layer/native-adapter.ts` `connect()` → `wireDriver()` | one `driver.connect()`; failure is *recorded*, never retried here; `epoch` stops a late connect from wiring state after a `disconnect()` |
| C2 | Driver Manager **Connect** / **Disconnect** | `installer-context.ts` `connectDriver`/`disconnectDriver` → `sil.connectNativeProtocol` → `engine.connectProtocol` | `driver.connect()` / `driver.disconnect()` |
| C3 | **60 s auto-retry** | `main.ts` tick → `installer-context.ts` `reconcileDriverConnectivity()` | for a driver already `ready` and unhealthy on the *previous* tick, calls C2's `connectNativeProtocol`. "Unhealthy" is `driver.isConnected() === false` |
| C4 | Driver (re)registration (install, config change, enable/disable) | `native-adapter.ts` `registerDriver` / `unregisterProtocol` | `old.disconnect()`, then `new.connect()` |
| C5 | `KnxProtocolDriver` itself | `knx-driver.ts` `connect()` | one in-flight guard (`this.connecting`) so concurrent callers share one attempt; **builds a new connection through `createConnection` on every attempt**; keeps it only after `connect()` resolved |
| C6 | `KnxHealthService` (native, not wired) | `health/health-service.ts` | own `ConnectionManager` + fresh tunnel per attempt |
| C7 | `KnxUltimateProvider` (commissioning path) | `knx-ultimate-provider.ts` | first connect direct, then `ConnectionManager.markConnected()` — the **hand-off pattern this design reuses** |

Facts that decide the design (all **[Certain]**, from the code above):

* `KnxProtocolDriver.isConnected()` is `this.conn !== null`; only `disconnect()` ever nulls it. The legacy wrapper has **no signal** for "the tunnel died after it was up", so C3 can only ever retry a driver whose *first* connect failed. A connection lost afterwards is invisible to the gateway loop and to the driver. (Whether `knxultimate` heals itself internally was not examined — **[Guessing]**; it is on the hardware list.)
* `KnxProtocolDriver.disconnect()` during its own in-flight `connect()` is a no-op (`conn` is still null); the connect then finishes and the driver keeps the connection. This pre-existing race applies to any `KnxConnection`, native or legacy. **Not fixed** (the driver is out of scope); see §5.
* The `KnxConnection` seam has four methods and no link-state callback.

## 2. Decision — one owner per phase, with a hard hand-off

> **The caller owns the first connection attempt. The `ConnectionManager` inside the connection owns every reconnection of an *established* link. The two phases never overlap.**

| Phase | Owner | Behaviour |
|---|---|---|
| First attempt | the caller (C1–C5) | `connect()` rejects with the real error. **A failed first attempt leaves nothing behind**: no timer, socket, listener, or half-open tunnel (asserted: 0 timers/sockets/channels after refusal, and 10 simulated minutes later no hidden retry reached the gateway). The gateway's 60 s loop therefore keeps working unchanged. |
| Established link lost | `ConnectionManager` in `SupervisedTunnel` | backoff + jitter, one reconnect timer at a time, a **fresh single-use `KnxTunnelClient` per attempt** |
| Disconnect / shutdown | the caller (`disconnect()`), final | cancels the owner; nothing is scheduled afterwards |

Why this and not the alternatives:

* *Gateway loop owns everything* — impossible: it cannot see a lost link (fact 1), and it would need `isConnected()` to flip, i.e. a driver change.
* *Connection owns the first attempt too (retry forever from `connect()`)* — would make `connect()` hang or leak a retry loop after the driver dropped its reference (C5 only keeps the connection after success), and would hide a mis-configuration the installer must see.
* *Both retry* — two loops against a gateway that may offer one tunnel slot: the self-DoS the driver's own `connecting` guard already had to fix once.

Because the hand-off is by phase, the 60 s gateway loop and the supervisor cannot compete: while the link is being recovered the driver still reports `isConnected() === true` (fact 1), so C3 never fires; while the first attempt keeps failing there is no supervisor.

## 3. Invariants enforced (each has a test; mutation-checked)

1. **One supervisor per connection**; `connect()` is idempotent and concurrent calls share one attempt (`tunnelsCreated == 1`, one gateway `connects`).
2. **One tunnel at a time.** A new tunnel is built only after the previous one is detached; a stale tunnel's late `closed` event is ignored (M15).
3. **One telegram feed per tunnel**, attached on link-up and detached on link-down, into a `NativeTelegramBus` that outlives tunnels. After N reconnects there is exactly one subscription per observer and each telegram is delivered exactly once.
4. **No duplicate subscriptions after reconnect** — subscriptions live on the bus, not on tunnels; the driver never needs to re-observe.
5. **A late handshake never attaches.** `disconnect()` marks an in-flight attempt cancelled; when its handshake ends, the tunnel is discarded with an orderly DISCONNECT (M2, M18, M13).
6. **No stale health monitor.** `onLinkUp` hooks (how a health monitor attaches) are started on *every* link-up and stopped on every link-down and on `disconnect()`, exactly once each (M12). `KnxHealthService.stop()` during an in-flight attempt used to leave a connected tunnel, an attached feed and a running monitor behind — **a defect from the previous milestone, reproduced by a failing test and fixed** (`candidate` tracking; M16).

## 4. Semantics, stated explicitly

**Backoff** (`ConnectionManager`, unchanged): first retry after `minBackoffMs` (default **2 s**), doubling to `maxBackoffMs` (**60 s**), ±10 % jitter, reset to the minimum after every successful connect, unbounded attempts until `disconnect()`. One attempt costs at most the tunnel connect timeout (10 s default). A gateway that still holds the dead tunnel answers "no more connections" until its idle timeout (modelled at 120 s) — expect the backoff to reach the cap in that case; this is **simulator behaviour, not measured on a gateway**.

**Cancellation (`disconnect()`)** — final, idempotent, never throws:

| Thing | Result |
|---|---|
| reconnect timer | cleared; never re-armed |
| first `connect()` promise | rejected `closed` **immediately** |
| in-flight handshake | **not aborted** (aborting before CONNECT_RESPONSE would orphan the gateway channel — the client does not know its channel id yet and a real gateway frees it only after its idle timeout). It finishes, is closed orderly, and attaches nothing. Bounded by the connect timeout; only ever closes. Asserted with a slow gateway: 0 channels remain after the late response. |
| attached tunnel | orderly DISCONNECT_REQUEST, bounded by the tunnel's disconnect timeout |
| pending/queued sends | rejected; reported as `outcome: "unknown"` for anything that could have been transmitted |
| pending reads | resolved `cancelled: disconnected` |
| observers | released synchronously (bus closed first; nothing is delivered afterwards) |
| link hooks (health monitor) | cleanup run once |
| later `connect()` / `write()` / `read()` | rejected `closed` / `not_sent`; a later `observe()` returns an inert handle |

**Shutdown** is the same call. Process-level shutdown must `await connection.disconnect()` (the engine already awaits `driver.disconnect()`).

**While the link is down:** `write()`/`read()` fail immediately `not_connected` / `not_sent` — no buffering across outages (the offline command queue is a separate, existing policy layer and is not duplicated here).

## 5. What is deliberately *not* solved here (known, recorded)

* **The driver cannot show link-down.** `isConnected()` stays true during recovery; the UI keeps saying "connected" while writes fail with a visible error. Same visibility as legacy today (worse in neither direction), but a native connection *could* report it. Proposed (needs a driver change): an optional `onLinkChange` on `KnxConnection`, consumed by the driver to flip `isConnected()` and re-publish status.
* **Driver `disconnect()` during its own in-flight `connect()`** still lets that connect finish and be kept (§1). Proposed driver fix: an epoch like `NativeAdapter.epoch`. Mitigated for the *replacement* case (C4) by `createSingleSlotConnectionFactory`: creating the next connection first disconnects its predecessor, cancelling a still-connecting one. Not wired anywhere; it is a helper for whoever builds the production factory later. A superseded driver keeps reporting `isConnected() === true` (it is being discarded).
* **Health service and driver on one gateway.** `KnxHealthService` still owns its own tunnel. Running it next to a `NativeKnxConnection` needs two tunnel slots. The intended integration is the `onLinkUp` hook (proved with a real `KnxHealthMonitor` in `knx-connection.test.ts`), which shares the one tunnel; moving `KnxHealthService` onto it is a follow-up, not done.
* **Race window of one microtask** between a successful attach and the manager's own `connected` transition: a close event delivered inside that window would be missed by `ConnectionManager.reportDisconnected`. Events come from timers/sockets (separate macrotasks), so this is not reachable from the tunnel today; noted rather than guarded.

## 6. Hardware evidence required before this can be called proven

Gateway reboot / power loss with a real tunnel (does the supervisor recover; how long does the dead channel block a 1-slot gateway); gateway-initiated DISCONNECT; abort during CONNECT_RESPONSE on a real gateway (orphan-channel lifetime); behaviour of `knxultimate` after the same events (does the legacy path ever notice?); a gateway offering exactly one tunnel; NAT/announced-data-endpoint cases.
