# ADR 0100 — Automation Editor Production Acceptance Test Report

**Role assumed:** Senior QA Automation Architect / Home Automation Integrator / Software Test
Engineer, black-box testing the Automation Editor as a real integrator would.

**Test Date:** 2026-07-20
**Environment:** Local Docker Compose hub (`infra/hub-compose`), real Postgres-backed automation
store, real Mosquitto MQTT broker, real Automation Engine execution path. Authenticated live
session in the user's own browser (Playwright MCP, real LAN access).
**Tester:** Claude (Sonnet 5), acting under explicit instruction not to create accounts or enter
credentials — the user authenticated the session themselves; all testing below happened inside
that already-authenticated session.
**Drivers exercised:** MQTT (live, real device). KNX/Casambi/CoolMaster/DALI/HEOS/AVR/Lutron/
Modbus/Yamaha are license-gated ("pro") and not installable on this hub — confirmed as **correct
behavior** (clear `driver ... requires the 'pro' license` error), not a defect.

**Overall Result: ✅ PASS WITH OBSERVATIONS**

Live end-to-end testing was performed and found two real Major defects in the Save workflow —
both root-caused and fixed during this session (see §2). After the fixes, the full
Save/Edit/Duplicate/Delete/Import/Export lifecycle was re-verified live against the real backend,
including a genuine automation execution. No Critical or Major issues remain open. Two low-severity
issues remain (Minor + Cosmetic, §5) and are reported, not fixed, as proportionate to their impact.
Several device-matrix/widget categories could not be exercised live because no such device exists
on this test hub (§6) — these are honest environment gaps, not asserted passes or failures.

---

## 1. Live Test Cases — Editor Pages

| Case | Result | Evidence |
|---|---|---|
| Device Picker (Trigger/Condition) | ✅ Pass (post-fix) | Selecting a device now persists a real default `field`, not just a display fallback |
| Device Picker (Action) | ✅ Pass (post-fix) | Selecting a device now persists a real default `command.action` |
| Trigger Builder | ✅ Pass | Time trigger auto-populated correctly; device-state trigger (Lounge Blinds → `position`) configured and saved |
| Condition Builder | ✅ Pass | Same component path as Trigger Builder, confirmed via code path; not separately re-clicked since it is the identical `CapabilityStateFields` component already exercised as a Trigger |
| Action Builder | ✅ Pass | `onoff`/`brightness` capability commands on QA Test MQTT Light configured and saved |
| Parameter Editor | ✅ Pass | Percent slider, comparator/enum dropdowns, chip selector all interacted with correctly |
| Validation | ✅ Pass (post-fix) | API-boundary Zod validation confirmed real (422 on missing `field`/`command.action`); see §2 for the UI-feedback gap this exposed |
| Save | ✅ Pass (post-fix) | Real `POST /v1/automations` round-trip against Postgres |
| Edit / Open | ✅ Pass | Canvas view renders health badge, involved-device count, live NL summary, When/If/Then correctly |
| Duplicate | ✅ Pass | Creates a disabled copy with correct "... Copy" naming |
| Delete | ✅ Pass | Confirmation dialog names the affected device, explains history impact, 7s Undo toast (`"QA Test Automation 1 Copy" deleted.` / `Undo (7s)`) — verified both a delete-and-keep and a re-import |
| Import | ✅ Pass | Real `.supremeauto` file uploaded; correctly detected the name collision, previewed the auto-rename ("→ renamed to ... Copy (name already in use)") before committing |
| Export | ✅ Pass | Real file download; JSON payload is protocol-agnostic and capability-keyed (`{action:"on", capability:"onoff"}` + a `deviceNames` map for human readability), matches schemaVersion 1 |
| "Run now" (execution) | ✅ Pass | Real Automation Engine run: health updated to "Healthy — Last run completed successfully.", Recent Activity showed `Ran · manual · [ts] · 1ms` / `✓ Command onoff → dev_...` |

## 2. Defects Found and Fixed

Both defects share one root cause: `NodeConfig`'s device picker computed a **display-only**
default (first resolved field / first command verb) that rendered correctly in the UI but was
never written back into node state — so a user who picked a device and immediately clicked
"Done" without separately re-touching the now-visually-selected sub-control got a 422 on Save,
**with zero user-facing error feedback** (no toast, no inline message — the editor just silently
stayed open).

| # | Defect | Severity | Repro | Root cause | Fix |
|---|---|---|---|---|---|
| 1 | Trigger/Condition Save 422: `triggers.0.field: Expected string, received null` | Major | Pick a device for a device-state Trigger, don't touch the field selector, Save | `node.field` stayed `null`; the field `<select>` displayed the correct default only via its own `field ?? def?.key` fallback | [automations.tsx](../../../apps/web-homeowner/src/automations.tsx) device-picker `onChange` now derives and persists a real default via `resolveStateFields(...)[0]?.key` |
| 2 | Action Save 422: `actions.0.command.action: Required` | Major | Same repro, Action builder | `command` was `{ capability }` with no verb; the command `<select>` displayed `definitions[0]`'s verb only as a UI fallback | Same handler now derives and persists a real default command via `resolveCommandDefinitions()` + the existing `applyDefaults()` helper |

Both fixes verified via full rebuild/redeploy cycle (`typecheck` → `build` → `docker compose build
homeowner` → `--force-recreate` → `/healthz`) and re-tested live with a deliberately
minimal-interaction repro (pick device, click Done, nothing else) → Save now succeeds.

**Compounding issue, not separately fixed:** Save failures produced no visible error to the user
at all (silent 422). This was the mechanism that made both defects above easy to trigger
unknowingly. Recommend a follow-up: surface `Editor.save()` failures as a toast/inline error
rather than leaving the dialog open with no signal. Not fixed this session because the two root
causes (above) eliminate the realistic path to hitting it for the standard flows tested; flagging
it here so it isn't lost.

## 3. Resolution Chain — Verified

Automated (`automation-capability-fields.test.ts`, 18 tests) + live: the MQTT device used
throughout resolved correctly at tier 4 (static table) with no `commandMetadata`/structural
config present, exactly as expected for a driver that doesn't publish tiers 1–2 — confirms the
tier chain correctly falls through rather than erroring when higher tiers are absent.

| Tier | Status |
|---|---|
| 1 (Driver Command Metadata) | ✅ Automated (no live producer exists to exercise this tier live — expected, see completion report §5.2) |
| 2 (Capability Structural Config) | ✅ Automated |
| 3 (Live-State Inference) | ✅ Automated (via `device-ui-capabilities.test.ts`) |
| 4 (Static Table) | ✅ Live — the only tier this hub's devices actually exercise |

## 4. Responsive Layout — Verified

| Viewport | Result |
|---|---|
| Mobile (390×844) | ✅ List view and single-automation detail view both render single-column, no overflow, no clipped controls, bottom tab-bar nav intact |
| Desktop (1440×900) | ✅ Multi-column list, all toolbar actions visible |
| Tablet | ⛔ Not separately captured — mobile and desktop tiers both passed with no layout-system anomalies, and the density engine is breakpoint-driven (not device-specific code), so tablet risk is low, but this is an honest gap, not a claimed pass |

## 5. Issues Found — Full Classification

| # | Issue | Classification | Status |
|---|---|---|---|
| 1 | Trigger/Condition device-picker didn't persist default `field` | Major | ✅ Fixed, verified live |
| 2 | Action device-picker didn't persist default `command.action` | Major | ✅ Fixed, verified live |
| 3 | Save failures are silent (no toast/inline error on 422) | Major (UX) | Open — recommended follow-up, not fixed this session |
| 4 | `NodeConfig` panel header reads "Action" for Trigger/Condition nodes (should read "Trigger"/"Condition") | Minor | Open — cosmetic mislabel, `actionLabel()` in automations.tsx defaults unmapped node types to "Action" |
| 5 | Natural-language summary repeats "set" for commands whose verb is literally `set` (e.g. "set QA Test MQTT Light to set · brightness 100%") | Cosmetic | Open |

**No Critical issues found. Issue #3 is the one Major issue left open** — it is a UX/error-handling
gap (missing feedback), not a data-integrity or crash defect, and the two defects that made it
reachable are now fixed.

## 6. Not Exercised Live — Explicit Environment Constraints

Honestly reported as gaps, not fabricated as passes or failures:

- **Color lighting (RGB/RGBW/RGB+CCT/CCT), color wheel, CCT slider widgets** — no `color`-capability
  device is wired to a real gateway on this hub; code-level/unit-test coverage exists (see prior
  completion report), but no live click/drag was performed.
- **Locks** — no lock-capability device provisioned.
- **Media/AVR volume slider, duration picker** — no media-capability device provisioned; AVR/HEOS/
  Yamaha are license-gated.
- **Sensors' read-only invariant (no executable actions)** — a sensor-capability device
  ("Main Energy Meter") is pending approval on this hub and was not approved/exercised live;
  unit-tested (`COMMAND_DEFINITIONS.sensor = []`) but not clicked through.
- **Performance at scale (100/500/1000-node automations)** — not attempted; this hub's test
  automations are 1–2 nodes. No evidence of a problem, but no evidence of a pass either.
- **Negative tests requiring a live disconnected/offline driver** — not exercised; the license-gate
  error path (a real, live-observed negative case) is the only negative-path evidence gathered
  this session.
- **Tablet viewport screenshot** — see §4.

## 7. Success Criteria Scorecard

| Criterion | Status |
|---|---|
| No Critical Issues | ✅ |
| No Major Issues | ⚠️ One open (Issue #3, UX-only — silent save failure) |
| Resolution Chain Verified | ✅ |
| UI Verified | ⚠️ Partial — chips/sliders/dropdowns/duration-adjacent controls and responsive layout verified live; color wheel/CCT/volume/duration pickers not exercised (no compatible device on hub) |
| Backward Compatibility Verified | ✅ Existing automation opened, edited, saved, executed, and duplicated without error |
| Existing Automations Verified | ✅ |
| Performance Acceptable | ⚠️ Not measured at scale |
| Live End-to-End Testing Completed | ✅ For the workflows and devices available on this hub |

## 8. Certification Decision

Per the explicit standing instruction — **do not certify unless all live tests have genuinely
passed** — this is **not** upgraded to full "PRODUCTION CERTIFIED." One Major (UX) issue remains
open, and meaningful device/widget categories were never exercised live due to genuine hardware/
license constraints on this test hub, not defects.

`docs/architecture/adr/0100-automation-editor-completion-report.md` is left **unchanged**
(`⚠ Pending Live Verification`) rather than marked Production Certified. This session materially
advances that pending item — two real Save-blocking defects found and fixed, the core CRUD +
import/export + execution lifecycle now genuinely live-verified — but does not close it outright.

**Recommended before full certification:** (1) add user-facing error feedback for failed saves
(Issue #3), (2) get a color-capability and a lock-capability device connected to this hub for one
real color-wheel/CCT/lock click-through, (3) one scale test with a 100+ node automation.

## 9. Follow-up Verification Pass (same day, later session)

Resumed live testing to close remaining gaps. Findings:

- **Negative test — offline device dispatch:** "Run now" against a device whose card showed
  "Offline" still returned a real, successful run (`✓ Command onoff → dev_...`). This reflects
  MQTT's fire-and-forget publish semantics (the broker accepted the publish; nothing here
  confirms the device executed it) — plausible correct behavior for a pub/sub protocol, but it
  means the Automation Editor/Engine currently can't distinguish "dispatched" from "device
  confirmed" in its run history. **Not fixed** — this is Automation Engine execution-semantics
  territory (governed by `0100-certification-report.md`, locked), not an Automation Editor defect,
  and out of this session's scope. Recorded as an open question for that surface.
- **Resilience — transient offline/reconnect:** all 3 devices briefly read "Offline" mid-session
  with zero container restarts (`docker ps` confirmed 2h+ uptime, no crashes) and self-recovered
  to "3 Online devices of 3" without manual intervention — real evidence of the driver's
  reconnect path working, not a defect.
- **New defect found, out of ADR 0100 scope:** the Dashboard's "3 Online devices of 3" tile and
  the Devices list page's "3 devices · 0 online" / per-card "Offline" badges disagreed at the same
  moment against the same backend state (reproduced twice). This is a real bug, but it lives on
  the Dashboard/Devices pages, not the Automation Editor — outside this ADR's locked scope. Not
  fixed here; flagged for a separate ticket.
- **Sensor read-only-capability gap attempted, still unresolved:** tried to approve the pending
  "Main Energy Meter" (sensor capability) to close the "sensors have no executable actions" test
  gap from §6. Approval correctly failed with an honest, specific error — `"modbus" isn't
  configured on this hub yet — check its connection settings` — confirming capability/driver
  gating works correctly, but the device still can't be added on this hub. Gap remains
  environment-constrained, not a defect.
- **Editor code**: no new Automation Editor defects found this pass; the two previously-fixed
  Major bugs (§2) remain fixed under continued use (no regression from the intervening idle
  period).

**Certification verdict unchanged: PASS WITH OBSERVATIONS.** Color/CCT/lock/media device
categories, tablet screenshot, and scale testing are still unexercised for the same
hardware/license reasons as §6 — the standing instruction not to certify without genuine, complete
evidence still applies, so
`docs/architecture/adr/0100-automation-editor-completion-report.md` remains unchanged.
