# SupremeOS Driver Resource Cleanup

> What a driver's `unbind()` must release, the resource taxonomy, the patterns used
> across the fleet, and the real leaks the platform audit found and fixed. Companion to
> [Driver-Lifecycle.md](./Driver-Lifecycle.md) and [Driver-SDK.md](./Driver-SDK.md).

## Resource taxonomy

Every resource a driver can hold on behalf of a device, and where it shows up in this
codebase:

| Resource | Examples in this fleet |
|---|---|
| Event Bus / internal observers | KNX/Matter's `subscribe()` per group address / node endpoint |
| WebSocket subscriptions | Casambi's wire (`CasambiWire`) |
| Timers | Poll intervals (Modbus, Shelly, Devialet, Sonos), Yamaha's per-host `getFeatures` refresh timer, Casambi's heartbeat ping |
| TCP sockets | AVR/HEOS Telnet links, Lutron LIP, CoolMaster ASCII_IF, KNX tunnelling |
| UDP sockets | Yamaha's shared event-push listener (driver-wide, not per-device — see below) |
| HTTP polling | Shelly/Devialet `Shelly.GetStatus` / `/ipcontrol` polling |
| Discovery listeners | mDNS/SSDP browses (one-shot per `discover()` call — nothing persistent to release) |
| Capability/state listeners | Every driver's own `listeners: Set<StateListener>` (driver-wide `onState`, not per-device — released on whole-driver `disconnect()`, correctly) |
| Automation / history subscriptions | Not held inside protocol drivers (they live above the SIL) |
| Internal observers | Matter/KNX per-binding attribute-report closures |
| Resource locks | In-flight-promise coalescing maps (Yamaha's `hostFeaturesInFlight`/`syncZoneInFlight`) — self-clearing via `.finally()`, not something `unbind()` needs to touch |
| Queued work | SupremeKnxDriver's `OfflineCommandQueue` — a device's still-queued offline commands |
| Per-device transport handles | Tuya's `clients: Map<address, TuyaDevice>` |

## The three (really four) patterns across the fleet

Almost every driver's per-device resource shape falls into one of these. Identify which
one a new driver is before writing its `unbind()` — see the
[Driver-Author-Guide](./Driver-Author-Guide.md) for the decision process.

### 1. Simple — flat bindings array + states map, no per-device shared resource

The device's own binding entries and cached state are the *only* thing to release; the
driver's shared resource (a poll timer, a bus connection) stays up because it's needed
regardless of which specific devices are bound. `unbind()` is exactly:

```ts
async unbind(deviceId: DeviceId): Promise<void> {
  removeDeviceBindings(this.bindings, deviceId);
  this.devices.delete(deviceId);
  removeDeviceStates(this.states, deviceId);
}
```

Drivers: **WiiM, DALI, Devialet, Shelly, Modbus, Lutron, SIP, Zigbee, Ajax, Casambi,
CoolMaster** (11 drivers).

### 2. Per-device transport handle with an optional `close()`

The device (or its shared player/sender object) has its own transport resource that
must be explicitly closed — but the client interface, as originally written, had **no
way to close it at all**. Fixed by adding an optional `close?(): Promise<void>` to the
client interface and calling it both from `unbind()` and (this was the actual leak —
see "Bugs found" below) from `disconnect()`.

```ts
async unbind(deviceId: DeviceId): Promise<void> {
  for (const b of this.bindings) {
    if (b.deviceId === deviceId) await b.player.close?.();
  }
  removeDeviceBindings(this.bindings, deviceId);
  this.devices.delete(deviceId);
  removeDeviceStates(this.states, deviceId);
}
```

Drivers: **AirPlay, Apple TV, Sonos**.

### 3. Shared subscription keyed by topic / group address / node endpoint

Multiple bindings (possibly across different devices) can point at the same underlying
subscription key. Releasing one device's binding must **only** tear down the shared
subscription once no other binding still needs it:

```ts
async unbind(deviceId: DeviceId): Promise<void> {
  for (const [key, list] of [...this.byKey]) {
    const remaining = list.filter((b) => b.deviceId !== deviceId);
    if (remaining.length === list.length) continue;
    if (remaining.length === 0) {
      this.byKey.delete(key);
      await this.unsubscribeFromWire(key);           // only now
    } else {
      this.byKey.set(key, remaining);
    }
  }
  this.devices.delete(deviceId);
  removeDeviceStates(this.states, deviceId);
}
```

Drivers: **MQTT** (topic-keyed — a topic can carry on/off + brightness for the same
device), **KNX** (`knx-driver.ts`, status-group-address-keyed via a per-binding
`unsubscribe` closure the transport now returns), **KNX** (`knx/supreme-knx-driver.ts`,
GA-scoped `unsubscribe()` on the provider — see "Bugs found"), **Matter** (node/endpoint
address-keyed, per-binding `unsubscribe` closure the controller now returns).

### 4. Shared physical link keyed by host (or host:port)

One TCP/HTTP link serves every device bound to that host — AVR zones, an entire HEOS
network, a Yamaha multi-zone unit. Release the shared link only when the **last** device
on that host is unbound:

```ts
async unbind(deviceId: DeviceId): Promise<void> {
  const removed = this.bindings.filter((b) => b.deviceId === deviceId);
  removeDeviceBindings(this.bindings, deviceId);
  this.devices.delete(deviceId);
  removeDeviceStates(this.states, deviceId);
  this.media.delete(deviceId);
  const releasedKeys = new Set(removed.map((b) => `${b.host}:${b.port}`));
  for (const key of releasedKeys) {
    if (this.bindings.some((b) => `${b.host}:${b.port}` === key)) continue;
    const link = this.links.get(key);
    if (link) {
      link.reconnect.stop();
      link.socket?.destroy();
      this.links.delete(key);
    }
  }
}
```

Drivers: **AVR** (Denon/Marantz Telnet — main zone + Zone 2 share one link), **HEOS**
(one TCP connection serves every player on the network), **Yamaha** (per-host feature
cache + refresh timer, not a persistent socket — Yamaha is per-request HTTP, but the
same "last reference wins" logic applies to the cached `getFeatures` result and its
`setInterval` refresh).

### Variant: per-device transport handle keyed by address (Tuya)

Tuya sits between patterns 3 and 4: each device address gets its own client connection
(`clients: Map<address, TuyaDevice>`), but — unlike AVR/HEOS — a single address's client
can be shared by more than one capability of the *same* device. `unbind()` tracks which
addresses the removed bindings used and only disconnects+forgets a client once no
remaining binding (of any device) still references that address.

## Bugs found and fixed during the platform audit

These are real defects the audit surfaced while implementing `unbind()` — not
speculative — each is covered by a regression test that failed before the fix.

1. **AirPlay / Apple TV / Sonos: `disconnect()` never actually cleaned up.** The
   whole-driver `disconnect()` cleared the shared timer but left `bindings`, `devices`,
   and `states` untouched, and never called anything on the per-device
   `sender`/`client`/`player` objects — because those interfaces had no `close()`
   method to call in the first place. Fixed by adding an optional `close?()` to all
   three client interfaces and calling it from both `disconnect()` (the pre-existing
   bug) and the new `unbind()`.

2. **Matter / KNX: `subscribe()` returned nothing — no way to unsubscribe, ever.**
   `MatterController.subscribe(addr, handler): void` and
   `KnxConnection.observe(ga, dpt, handler): void` had no return value. Every closure
   registered with them lived for the life of the controller/connection, no matter what
   `unbind()` did to the driver's own `bindings` array — a genuinely unbound device's
   handler kept firing, re-populating `states` and re-emitting `onState` events for a
   device the platform believed was gone. Fixed by changing both signatures to return
   an unsubscribe function (`(): void`), storing it per-binding
   (`b.unsubscribe = controller.subscribe(...)`), and calling it in `unbind()`. Both
   test fakes (`matter-driver.test.ts`, `matter-fabric.test.ts`, `knx-driver.test.ts`)
   updated to match; both drivers' real-transport wrappers
   (`wrapKnxUltimate` in `knx-driver.ts`) updated to actually remove the handler from
   their internal observer list, not just satisfy the type.

3. **`SupremeKnxDriver` (the parallel/future KNX implementation,
   `knx/supreme-knx-driver.ts`): the provider's `unsubscribe(groupAddress)` is
   GA-scoped, not per-handler.** `IKnxProvider.unsubscribe()` deletes *every* observer
   on a group address, not just one device's. Calling it unconditionally from
   `unbind()` would silently kill a second device's live updates if it happened to
   share a status GA with the one being unbound (an installer configuration that's
   unusual but not invalid). Fixed by only calling `unsubscribe(ga)` once no other
   remaining binding still references that GA — covered by a dedicated regression test
   ("does not unsubscribe a status GA still shared by another bound device").

4. **`SupremeKnxDriver`'s offline command queue had no per-device eviction.** A command
   issued while disconnected queues (`OfflineCommandQueue`, MERGE + TTL-expire
   semantics); the queue itself only ever supported `clear()` (everything) or
   `drain()` (execute what's still fresh). A device unbound while it had a command
   queued would leave that command sitting until its TTL expired (5 minutes by
   default) — bounded, but a real "nothing may remain after unbind() completes"
   violation. Fixed by adding a generic `evict(predicate)` method to
   `OfflineCommandQueue` (reusable — it's typed over any subject, not KNX-specific) and
   calling `this.offlineQueue.evict((subject) => subject === deviceId)` from
   `SupremeKnxDriver.unbind()`.

5. **`SupremeNativeAdapter.connect()` was not idempotent — a real reconnect-storm
   leak.** `connect()` unconditionally iterated every registered driver and called
   `driver.onState(handler)` again, with no check for "did I already wire this driver."
   Each additional call added *another* listener to every driver's own listener set —
   they're never unsubscribed until `disconnect()` — so N redundant `connect()` calls
   (a real scenario under a boot/reconnect signal flapping) caused every subsequent
   state event to fire N times. Found by a written regression test simulating 20 rapid
   `connect()` calls, which failed with 21 duplicate events before the fix (one initial
   listener + 20 more from the loop). Fixed with a one-line guard:
   `if (this.connected) return;` at the top of `connect()`. Verified safe against every
   existing call site (`sil.ts`, `routing-adapter.ts` each call `connect()` exactly
   once) and the full gateway/integration-layer test suites (222 + 47 tests) before and
   after.

## Full driver audit table

Pattern column: **1**=simple, **2**=per-device close(), **3**=shared subscription
key, **4**=shared host link, **T**=Tuya's address-keyed transport variant.

| Driver | File | Pattern | `unbind()` before this effort | `unbind()` now |
|---|---|:-:|:-:|:-:|
| AVR | `avr-driver.ts` | 4 | ❌ missing | ✅ |
| HEOS | `heos-driver.ts` | 4 | ❌ missing | ✅ |
| Yamaha | `yamaha-driver.ts` | 4 | ❌ missing | ✅ |
| WiiM | `wiim-driver.ts` | 1 | ❌ missing | ✅ |
| AirPlay | `airplay-driver.ts` | 2 | ❌ missing (+ `disconnect()` bug) | ✅ |
| Apple TV | `apple-tv-driver.ts` | 2 | ❌ missing (+ `disconnect()` bug) | ✅ |
| DALI | `dali-driver.ts` | 1 | ❌ missing | ✅ |
| Devialet | `devialet-driver.ts` | 1 | ❌ missing | ✅ |
| Sonos | `sonos-driver.ts` | 2 | ❌ missing (+ `disconnect()` bug) | ✅ |
| Shelly | `shelly-driver.ts` | 1 | ❌ missing | ✅ |
| Modbus | `modbus-driver.ts` | 1 | ❌ missing | ✅ |
| MQTT | `mqtt-driver.ts` | 3 | ❌ missing | ✅ |
| Lutron | `lutron-driver.ts` | 1 | ❌ missing | ✅ |
| SIP | `sip-driver.ts` | 1 | ❌ missing | ✅ |
| Zigbee | `zigbee-driver.ts` | 1 | ❌ missing | ✅ |
| Ajax | `ajax-driver.ts` | 1 | ❌ missing | ✅ |
| Casambi | `casambi-driver.ts` | 1 | ❌ missing | ✅ |
| CoolMaster | `coolmaster-driver.ts` | 1 | ❌ missing | ✅ |
| Tuya | `tuya-driver.ts` | T | ❌ missing | ✅ |
| Matter | `matter-driver.ts` | 3 | ❌ missing (+ leaked-observer bug) | ✅ |
| KNX | `knx-driver.ts` | 3 | ❌ missing (+ leaked-observer bug) | ✅ |
| KNX (parallel/future impl) | `knx/supreme-knx-driver.ts` | 3 | ❌ missing (+ GA-scoped-unsubscribe + queue-eviction bugs) | ✅ |

**22 of 22 drivers** in `@supreme/protocols` now implement `unbind()`. Zero had it
before this effort, including the three flagship AVR-family drivers (AVR/HEOS/Yamaha)
that the original production audit was scoped around — this was corrected as part of
completing this platform-wide rollout, not assumed from the earlier audit's summary.

See [Driver-Lifecycle.md](./Driver-Lifecycle.md) for the full final compliance report
and remaining known issues.
