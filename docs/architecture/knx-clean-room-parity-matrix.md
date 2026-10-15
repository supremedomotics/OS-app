# SupremeOS KNX Clean-room Replacement — Parity Matrix

This is an initial, deliberately incomplete inventory scaffold. Every row must be linked to a test and assigned a status before the transport can be switched on. The repository contains more functionality than a single driver file; update this matrix as the current implementation is audited.

| Domain | Existing evidence / source | Required replacement proof | Status |
|---|---|---|---|
| Production driver path | `services/gateway/src/bootstrap.ts`, `services/protocols/src/knx-driver.ts` | Production driver has no `knxultimate` import; adapter contract tests pass | Not started |
| Commissioning provider path | `services/protocols/src/knx/supreme-knx-driver.ts`, `knx-ultimate-provider.ts` | Task routing parity without legacy transport | Not started |
| KNX IoT Point API | `knx-iot-transport.ts`, `knx-iot-provider.ts` | Remains independent CoAP discovery/metadata transport | Audit |
| Gateway discovery | `knx-discovery.ts` and test files | Frame validation, NIC selection, no false positives | Audit |
| Tunnelling handshake | `knx-ultimate-provider.ts`, `connection-manager.ts` | Normative protocol tests, real gateway HIL | Not started |
| Session heartbeat / recovery | `connection-manager.ts`, provider tests | One connection attempt, deadlines, no leaks, deterministic recovery | Not started |
| GroupValue Write | `knx-driver.ts`, `knx-codec.ts` | Correct cEMI/APCI, ACK distinction from actuator feedback | Not started |
| GroupValue Read | Existing provider and provider tests | Response correlation and timeout; requests never become state | Not started |
| GroupValue Response | Existing indication handler | Correct parsing, type filtering and feedback attribution | Not started |
| DPT codec parity | `knx-codec.ts`, ETS fixtures | Golden vectors for all actually deployed DPTs | Inventory needed |
| On/off / dimming / position | `knx-codec.ts`, `knx-driver.test.ts` | Existing values and clamping unchanged | Not started |
| RGB / RGBW / CCT | `knx-codec.ts`, capability mapper tests | Byte-level and semantic parity | Not started |
| Sensors / locks | `knx-codec.ts`, `knx-driver.test.ts` | Correct read-only / boolean semantics | Not started |
| HVAC multi-GA roles | `knx-driver.ts`, HVAC tests | Role decoder parity; invalid values never fabricated | Not started |
| Keypad inputs | `supreme-knx-driver.ts` | Press/release path, no fake short/long classification | Not started |
| Multiple observers on one GA | Existing observer maps and driver tests | Fan-out correct; removing one subscriber preserves others | Not started |
| Bind/unbind / ownership | Existing driver tests | No leaked listener, state, queue item, or cross-device cleanup | Not started |
| Reconnect synchronization | Driver and provider tests | Status read-back is bounded, queued commands safe | Not started |
| Offline queue | `offline-command-queue.ts` | TTL, coalescing, safe command policies and reconnect drain | Audit |
| ETS `.knxproj` import | `services/commissioning/src/knx/ets-parser.ts` | No transport coupling or import regressions | Audit |
| GA XML / ESF import | `ga-export-parser.ts`, `esf-parser.ts` | No mapping, room or DPT regressions | Audit |
| Device/room recognition | `device-recognition-engine.ts`, `room-assignment-engine.ts` | Existing review confidence and override behaviour | Audit |
| Individual-address diagnostics | Not yet verified in production path | Supported/unavailable/ambiguous statuses using protocol evidence | Not started |
| Feedback diagnostics | Existing packet counters and unmatched telegram snapshots | Read timeout, stale feedback, GA/DPT mismatches distinguished | Not started |
| Root-cause report | New capability | Evidence-backed diagnosis and bounded support export | Not started |
| Self-heal audit | Connection manager exists; policy layer needed | Safe action levels, bounded retries, event history and cancellation | Not started |
| Routing mode | Existing discovery reports routing capability | Real multicast transport, separate from tunnelling; HIL proof | Not started |
| KNX IP Secure | Legacy package supports it per public package documentation; actual Supreme usage unverified | Implement/test keyring and session behaviour or declare unsupported | Inventory needed |
| KNX Data Secure | Legacy package supports it; actual project use unverified | ETS keyring / per-GA secure payload tests or declare unsupported | Inventory needed |
| Dependency / SBOM | `services/protocols/package.json`, `pnpm-lock.yaml`, build/container configs | No source, lockfile, bundle or image dependency on `knxultimate` | Not started |
| Legal provenance | Blueprint + dependency notices | Review independent implementation process, licenses and notices | Not started |

## Rule

Never set a status to Pass based on source inspection alone when a runtime or protocol behaviour is claimed. Use separate labels:
- Audit: source/tests reviewed, no conclusion yet.
- Unit pass: new deterministic tests pass.
- Integration pass: simulator/router integration passes.
- HIL pass: tested against a real KNX IP interface / KNX bus.
- Deferred: intentionally not shipped and clearly visible to integrators.
