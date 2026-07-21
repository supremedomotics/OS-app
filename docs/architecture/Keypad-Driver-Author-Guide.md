# Keypad Driver Author Guide

> How a future keypad driver (KNX push-button, Casambi keypad, Lutron Pico, Matter
> switch, MQTT button, RTI keypad, Zigbee remote, BLE fob, DALI push-button input
> unit, …) plugs into the [Universal Keypad Framework](./Universal-Keypad-Framework.md)
> (ADR 0016). Written from
> `services/integration-layer/src/protocols/keypad-extensibility.test.ts` — a real,
> compiling, passing proof that the seam's public surface is sufficient for a
> from-scratch driver, not a theoretical description. That file is a **synthetic,
> fake, non-real protocol** (`"fake-keypad-extensibility-proof"`, no manifest, not
> registered anywhere real) built solely to prove the seam works, per this
> framework's explicit Phase 1 scope: no real keypad driver ships yet. When a
> **real** keypad protocol implementation begins, THIS guide — not the fake test
> file — is what to follow.

## The contract: three new OPTIONAL members, nothing else

Your driver already implements (or will implement) `INativeProtocolDriver` — the
exact same interface every driver in the fleet implements
(`services/integration-layer/src/protocols/driver.ts`). A keypad additionally
implements zero, some, or all of:

```ts
getKeypadCapabilities?(deviceId: DeviceId): KeypadCapabilityDeclaration | null;
onInputEvent?(listener: (event: KeypadInputEvent) => void): () => void;
sendKeypadFeedback?(command: KeypadFeedbackCommand): Promise<void>;
```

None of this is AV/media/climate-specific plumbing you have to route around — it's
additive to the same contract, exactly like `getArtwork?`/`getDiagnostics?` are for
media/diagnostics. **Never** implement a protocol-specific event/command type here;
everything you produce/consume is one of the generic types from
`@supreme/domain-model`.

## Step 1 — declare your controls (`getKeypadCapabilities`)

After `bind()` succeeds for a keypad device, report what it actually has — never a
guessed or copy-pasted "every keypad has this" shape:

```ts
getKeypadCapabilities(deviceId: DeviceId): KeypadCapabilityDeclaration | null {
  if (!this.manages(deviceId)) return null;
  return {
    keypadId: deviceId,
    protocol: this.protocol,
    controls: [
      { id: "btn1", kind: "button", label: "Scene 1", input: ["buttons", "long_press"], feedback: ["led"] },
      { id: "btn2", kind: "button", label: "Scene 2", input: ["buttons"], feedback: [] }, // no LED on this button
    ],
  };
}
```

- `id` is YOUR driver's own stable identifier for that physical control — never a
  raw protocol address. It's what mappings/subscriptions/events all key on.
- `input`/`feedback` are per-CONTROL, not per-device — a keypad can genuinely mix
  a plain button (no feedback) with an LED button and a rotary encoder.
- If your protocol has no wire-level way to enumerate controls (some KNX ETS
  imports, for instance), this becomes installer-declared config, same pattern as
  `avr-capabilities.ts`'s `source: "device_reported" | "installer_declared"` — see
  that file for the precedent, though note `KeypadCapabilityDeclaration` doesn't
  yet carry that tag (a straightforward future addition, additive, when a real
  driver needs it — don't add it speculatively now).

## Step 2 — publish input (`onInputEvent`)

Translate your protocol's raw traffic into `KeypadInputEvent`s and hand them to
every registered listener:

```ts
private readonly inputListeners = new Set<(event: KeypadInputEvent) => void>();

onInputEvent(listener: (event: KeypadInputEvent) => void): () => void {
  this.inputListeners.add(listener);
  return () => this.inputListeners.delete(listener);
}

private onWireByte(raw: MyProtocolFrame): void {
  const event: KeypadInputEvent = raw.pressed
    ? { type: "button_pressed", keypadId: this.deviceFor(raw), control: raw.controlId, ts: new Date().toISOString() }
    : { type: "button_released", keypadId: this.deviceFor(raw), control: raw.controlId, ts: new Date().toISOString() };
  for (const l of this.inputListeners) l(event);
}
```

**You almost always publish raw `button_pressed`/`button_released`** and let the
`UniversalInputEngine` derive short/long/double/triple-press and hold-start/
holding/hold-end — don't reimplement press-timing in your driver. The one
exception: hardware with genuine onboard press-timing or gesture recognition (a
rotary encoder reporting `rotate_clockwise` deltas directly, a touch-strip
reporting its own `swipe`) publishes that semantic event directly — the engine
passes anything that isn't a raw press/release straight through unchanged.

## Step 3 — accept feedback (`sendKeypadFeedback`)

```ts
async sendKeypadFeedback(command: KeypadFeedbackCommand): Promise<void> {
  const target = this.controlFor(command.keypadId, command.control);
  if (!target) return; // not managed by this driver — safe no-op, mirrors bind()/manages() conventions
  switch (command.type) {
    case "led_on": await this.writeLed(target, true); return;
    case "led_off": await this.writeLed(target, false); return;
    case "led_brightness": await this.writeLedBrightness(target, command.level); return;
    // ...only implement the cases your hardware's controls actually declared in
    // getKeypadCapabilities — the Universal Feedback Engine already gates on the
    // declaration before calling you, so an undeclared type should never arrive in
    // practice; still, never throw for one that does — a compliant caller isn't
    // the only caller a hub will ever have.
    default: return;
  }
}
```

## Step 4 — the manifest (Driver Store / Extension Center visibility)

Same requirement ADR 0015 corrected for AVR/HEOS/Yamaha: a driver with no
`DriverManifest` entry is invisible in the Driver Manager UI. Add yours to
`ProtocolKind` (`packages/domain-model/src/drivers.ts`) and a manifest + a
`native-driver-factory.ts` entry, exactly like every existing protocol.

## Per-protocol notes (real, evidence-based — verify before building)

These are starting hypotheses for future research, not verified facts (no real
research pass has been done on any of these for THIS framework yet — do the same
spec-verification work ADR 0015 did for AVR before assuming any of these):

- **KNX**: push-buttons are typically bare contact closures on a group address —
  expect `button_pressed`/`button_released` only, no onboard press-timing. LED
  feedback (if any) is usually a separate group address write, not a query-back —
  same "write-only" shape the existing KNX driver already handles for other
  capabilities.
- **Casambi**: the existing `casambi-driver.ts`/`casambi-transport.ts` already
  has a live BLE/cloud-gateway connection for lights; a Casambi *keypad* would
  likely reuse that same transport, reporting button events over the same
  connection used for light control — check whether Casambi's SDK exposes a
  keypad/switch object type before assuming device-level parity with lights.
- **Lutron**: `lutron-codec.ts`/`lutron-driver.ts` already parse LIP integration
  report strings for RadioRA2/HomeWorks QS and Caséta Pro; Pico remotes report
  button press/release over the same LIP telnet stream — likely the most
  natural first real driver to build, given the transport already exists.
- **Matter**: a switch device type (`Switch`/`GenericSwitch` clusters) reports
  press events via attribute reports/events over the existing `matter-driver.ts`
  seam (`@matter/main`) — verify against the actual cluster spec before building.
- **MQTT**: a button publishing to a topic is the simplest possible case for
  `mqtt-driver.ts`/`mqtt-discovery.ts` (already handles Zigbee2MQTT discovery) —
  likely reports `button_pressed`-shaped payloads only, feedback (if any) is a
  separate publish.
- **Zigbee**: `zigbee-driver.ts` (via `zigbee-herdsman`) already handles generic
  Zigbee clusters; many Zigbee remotes report semantic click counts natively
  (some report "double-click" as a distinct cluster command) — check whether to
  publish that directly as `double_press` rather than raw press/release.
- **RTI / BLE / DALI**: no existing transport in this fleet for RTI; BLE has the
  Casambi transport as a partial precedent; DALI push-button input units
  (`dali-driver.ts`/`dali-codec.ts` already handle DALI light control) report
  button events over the same DALI bus — the natural next real target after
  Lutron/KNX.

## Testing your driver

Follow the extensibility proof's shape: build a synthetic in-process test
(`connect`/`bind`/`getKeypadCapabilities`/`onInputEvent`/`sendKeypadFeedback`)
against `SupremeNativeAdapter` + `SupremeIntegrationLayer` before wiring up real
hardware, exactly like `keypad-extensibility.test.ts` does. Add your driver's own
protocol-specific codec tests (frame parsing, LED command encoding) the same way
every other driver in the fleet does (see `avr-codec.ts`'s test file for the
established pattern of a pure codec module tested independently of the transport).
