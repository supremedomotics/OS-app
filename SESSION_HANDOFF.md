# SESSION_HANDOFF.md

> Current development state. **Rewrite this at the end of every session** — it should describe
> what changed *since the previous handoff*, not the whole project history (that's
> `PROJECT_CONTEXT.md`). Keep it concise.

**Branch:** `claude/supremeos-universal-av-sdk-0rtaiw`, based on `main` at session start. This
turn had two parts: (1) an **AV architecture verification report** (no code changes — answered
"is AVR/HEOS/Yamaha a real Universal SDK with brand adapters, or three independent thick
drivers?" honestly: three independent thick drivers, no SDK layer exists in code, only in docs);
(2) a large **AV SDK refactor** was then requested to close that gap, planned in detail (3
research agents + 1 design-critique agent, full duplication audit, evidence-scoped module design)
but **rejected by the user before execution** in favor of a different task; (3) **Automation
Editor Production Hardening** — the task actually executed this turn.

## Part 1 — AV architecture verification (no code changes)

Answered a direct question: does the AV driver layer match a "Universal AV SDK → brand adapter →
transport → device" architecture? No — `AvrProtocolDriver`/`HeosProtocolDriver`/
`YamahaProtocolDriver` each independently implement `INativeProtocolDriver` directly; there is no
SDK layer in code, only in `docs/architecture/avr-sdk-developer-guide.md`'s documentation. Denon
and Marantz are correctly the SAME driver (identical wire protocol, not a missed consolidation).
No files changed.

## Part 2 — AV SDK Refactor (planned in full, then rejected — plan discarded)

The user then asked for a full "Universal AV SDK" refactor converting AVR/HEOS/Yamaha into thin
adapters. This was planned rigorously (plan mode, 3 parallel Explore agents + 1 Plan-agent
critique pass) before any code was touched:
- **Real audit finding**: the actual duplication is narrow — a ~55-line TCP-link-pool + reconnect
  + line-buffering pattern between AVR/HEOS, plus `record()` (verbatim identical in all 3
  drivers), a diagnostics-status ternary, an `onData` skeleton, and one dead-duplicated
  `parseHostPort()`. Most of the requested 20-subsystem/17-future-brand target architecture either
  already exists elsewhere as generic fleet infrastructure (Room Assignment Engine, Diagnostics
  route, the Device/CapabilityState model) or has no evidence to justify building it
  (Telemetry/Metrics/Subscription-Manager/a unified Zone Engine — AVR/HEOS/Yamaha genuinely model
  zones incompatibly at the wire level).
- User confirmed (via `AskUserQuestion`) a scoped, evidence-based extraction plan: one
  `services/protocols/src/av-sdk/` module (`TcpLineTransport` + `state-cache.ts`), AVR/HEOS
  migrated to use it, Yamaha only getting the `record()` extraction ("thinner, not thin" — HTTP
  transport has no second caller in the fleet, building an HTTP-transport SDK primitive now would
  be speculative), zero stub adapters for the 17 unbuilt brands (would violate "never fabricate
  capabilities").
- **The full plan was written to `/root/.claude/plans/polished-stirring-dongarra.md` and presented
  via `ExitPlanMode` — the user rejected it** (pasted an entirely different task instead, see Part
  3). **No code from this plan was ever applied.** If this work is wanted later, the plan file and
  the reasoning above are the starting point — the audit findings are still accurate (nothing in
  `avr-driver.ts`/`heos-driver.ts`/`yamaha-driver.ts` changed this session).

## Part 3 — Automation Editor Production Hardening (executed)

The rejected AV SDK task was replaced with a "Automation Editor Production Hardening (ADR-0100)"
brief. **Critical finding, surfaced to the user twice via `AskUserQuestion` before proceeding**:
ADR-0016 through ADR-0021 and ADR-0100 do not exist anywhere in this repository (only ADR-0001–15
do); "Runtime Objects"/"Runtime Events" aren't this codebase's vocabulary; and the requested
four-level field-resolution pipeline (Driver Command Metadata → Capability Structural
Configuration → Live-State Inference → Static Capability Table) doesn't exist either — the real
Automation Editor (`apps/web-homeowner/src/automations.tsx`) has a small hardcoded onoff-only
field set with no capability-driven resolution at all. User confirmed: proceed against the real
implementation (governed by **ADR-0005**, "Native automation engine, AI drafts, and append-only
audit"), document the real gap honestly, present the requested pipeline/metadata contract/
maturity model as clearly-labeled **future proposals**, don't implement them.

**What actually changed** (see `docs/architecture/Automation-Editor-Production-Hardening-Report.md`
for the full report):
- `apps/web-homeowner/src/automations.tsx`: replaced the loose `Record<string, unknown> & { type:
  string }` node type with a real `EditorNode` discriminated union — removed 6 unsafe `as` casts,
  made `defaultNode()`/`nodeSummary()` compiler-enforced-exhaustive switches, added a runtime type
  guard (`isEditorNodeType`) at the one real untyped boundary (the HTML5 drag-and-drop payload).
  Fixed one real "obvious" performance issue found during review: the device-picker's room/device
  fetch was N sequential HTTP round-trips instead of one parallel `Promise.all` batch.
- `apps/web-homeowner/src/api.ts`: one documentation comment added (no code change) explaining why
  `AutomationView` is intentionally narrower than the full domain-model `Automation` type.
- New `apps/web-homeowner/src/automations.test.ts`: 9 tests for the file's pure helper functions —
  previously **zero** test coverage existed for this file (in fact for the entire
  `@supreme/web-homeowner` app — no `.test.tsx` anywhere, no `@testing-library/react`/jsdom
  dependency). Component-level tests were investigated and explicitly NOT added — would require
  introducing new test infrastructure to an app that's never had any, a real scope decision,
  documented as a `TODO.md` follow-up rather than silently done or silently skipped.
- Nothing in `services/automations/`, `packages/domain-model/src/automations-dsl.ts`,
  `packages/supreme-contracts/src/phase3.ts`, `services/persistence`'s automation repo, or the
  gateway automation routes was touched — this is the evidence behind the report's "zero
  serialization/persistence/execution-engine impact" claim, not an inference.
- Three new docs: `docs/architecture/Automation-Editor.md` (architecture + real current
  field-resolution pipeline + driver integration guide), `Automation-Editor-Future-Driver-SDK-
  Roadmap.md` (Command Metadata contract examples, maturity model, extension points — all
  explicitly labeled unimplemented), `Automation-Editor-Production-Hardening-Report.md` (the full
  14-part report: code review, performance, type safety, test coverage, backward-compat matrix,
  serialization/protocol-compatibility validation, release-candidate validation).

**Verification**: full monorepo `pnpm build` (54/54 packages), `pnpm typecheck` (93/93 tasks),
`pnpm test` (all passing, including the 222 pre-existing gateway tests confirming zero regression)
— all green after the change. No lint gate exists anywhere in this repo (confirmed, not assumed —
no package defines a `lint` script, no ESLint/Biome config exists); this is reported honestly in
the hardening report rather than silently skipped.

## Known issues / open gaps (new this turn)

- Cross-platform duplication: the web (`automations.tsx`) and mobile
  (`apps/mobile/lib/screens/automation_editor.dart`) Automation Editors independently hand-
  implement the identical six-node palette/defaults/field rules — not literal shared code (TS/Dart
  can't share modules), documented not fixed.
- The real, honest field-resolution gap: the DSL/engine already support triggers/conditions/
  actions across every `CapabilityKind` (brightness/color/temperature/position/media/lock/fan/
  vacuum/sensor) and the full `CapabilityCommand` union; the editor UI only authors `onoff`. A
  homeowner cannot build "when brightness drops below 20%, run a scene" through either
  drag-and-drop builder today, even though the backend already executes it. Documented in
  `Automation-Editor.md` §2; NOT fixed (would be new user-facing functionality, explicitly out of
  scope for a hardening pass).
- `AutomationService` (the CRUD layer in `services/automations/src/service.ts`) has no direct unit
  tests — only one happy-path e2e test covers create + WSS-observed execution; update/delete/
  enable-toggle/list/runs and validation-error paths are untested. Flagged, not filled (was outside
  this pass's touched-files scope).
- `HeosProtocolDriver`'s `queryPlayers()` (discovery-only) reimplements manual line buffering
  instead of reusing `LineAccumulator`, with no `maxBytes` cap — found during the (discarded) AV
  SDK refactor's audit, still real, still unfixed, still in `TODO.md`.
- The AV SDK refactor itself (Part 2 above) remains fully unimplemented — the plan and evidence are
  preserved in this handoff and the discarded plan file if picked back up later.

## Immediate priorities for the next session

1. If the AV SDK refactor is wanted after all: start from Part 2's evidence (still accurate,
   nothing in the AV drivers changed this session) rather than re-auditing from scratch.
2. If continuing Automation Editor work: the real field-resolution gap (onoff-only authoring) is
   the highest-value next step, but is a **feature**, not a hardening task — needs its own scoped
   session/ADR, not a bolt-on.
3. Component-test infrastructure for `apps/web-homeowner` (`@testing-library/react` + jsdom) is a
   real, currently-nonexistent gap worth a dedicated small session before more UI hardening passes
   rely on "add tests" the same way this one did (pure-function tests only).
4. Everything from the prior (Driver Lifecycle Completion) handoff not touched this session remains
   open — see `TODO.md` for the full backlog with priority tiers.
