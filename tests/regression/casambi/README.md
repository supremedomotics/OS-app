# Casambi Packet Replay — Regression Capture Library

Every file here is a `PacketCapture` (JSON — see `services/lan/src/server/replay-dgram-socket.ts`
for the exact shape), automatically loaded and replayed through the real
`CasambiProtocolDriver` + `NatsUdpTransportClient` + `UdpTransportServer` pipeline by
`services/protocols/src/casambi/casambi-packet-replay-regression.test.ts` — no hardware required
to run the suite. Adding a new `.json` file anywhere under this directory (recursively) is enough
to add it to the suite; no test code changes needed.

## Directory layout

- `living-room/` — the REAL, Wireshark-captured NotifyControlValues packet from the original
  hardware audit session. Real hardware evidence, not synthetic.
- `kitchen/`, `office/` — synthetic but wire-valid captures exercising specific pipeline paths
  (a button press; a well-formed but unmapped opcode). Clearly labeled as synthetic in each
  file's own `metadata.notes`.
- `button-events/`, `sensor-events/`, `dimming/`, `scenes/` — reserved categories from the
  governing certification brief. **Currently empty.** No synthetic capture was fabricated to fill
  these — that would misrepresent an invented payload as evidence of real device behavior. Populate
  them with REAL captures (preferred, via the Live Capture workflow below) or carefully
  hand-constructed synthetic ones following `udp-codec.ts`'s documented byte layouts, same as
  `kitchen`/`office` were built.

## Capture metadata

Every capture's `metadata` field (optional but expected) should record:

```json
{
  "firmwareVersion": "6.25",
  "gatewayVersion": null,
  "dataFormat": "hex-dot",
  "netId": 12,
  "date": "2026-08-01",
  "notes": "free text — what this capture demonstrates, real or synthetic"
}
```

Use `null` for anything not actually known — never guess a firmware/gateway version or a capture
date you don't have real evidence for.

## Adding a real capture from real hardware (Live Capture)

```ts
import { replayableDgramSocket, saveCaptureJson } from "@supreme/lan/server";

const socket = replayableDgramSocket(); // real node:dgram
// ... wire socket into your running supreme-lan / driver as usual ...
const recording = socket.startRecording();
// ... trigger real activity on the real gateway (toggle a light, press a button) ...
const capture = recording.finish("dimming-example", "real 50% dim command feedback", {
  firmwareVersion: "6.25",
  netId: 12,
  dataFormat: "hex-dot",
  date: new Date().toISOString().slice(0, 10),
  notes: "Captured live against a real gateway during commissioning.",
});
await saveCaptureJson(capture, "tests/regression/casambi/dimming/real-example.json");
```

See `docs/architecture/Casambi-Final-Hardware-Validation-Report.md` §3 (Packet Replay Framework
Guide) for the full API, and `docs/architecture/Casambi-Real-Hardware-Validation-Runbook.md` for
the end-to-end certification workflow this library feeds into.
