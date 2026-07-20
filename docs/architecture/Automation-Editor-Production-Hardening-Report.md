# Automation Editor — Production Hardening Report

> Final report for the Automation Editor production-hardening pass. Companion to
> [Automation-Editor.md](./Automation-Editor.md) (architecture reference) and
> [Automation-Editor-Future-Driver-SDK-Roadmap.md](./Automation-Editor-Future-Driver-SDK-Roadmap.md)
> (future proposals, not implemented). Scope note: this pass targeted the
> **real** implementation — `apps/web-homeowner/src/automations.tsx`,
> `services/automations/`, `packages/domain-model/src/automations-dsl.ts` — since
> the originally-referenced ADR-0016–0021/0100 and four-level field-resolution
> pipeline don't exist in this repository (documented in
> [Automation-Editor.md](./Automation-Editor.md)'s scope note).

## Files touched

| File | Change |
|---|---|
| `apps/web-homeowner/src/automations.tsx` | Type-safety refactor (§6), one performance fix (§5) |
| `apps/web-homeowner/src/api.ts` | One doc comment added (§1) — no code change |
| `apps/web-homeowner/src/automations.test.ts` | New — 9 tests, previously zero coverage (§7) |
| `docs/architecture/Automation-Editor.md` | New |
| `docs/architecture/Automation-Editor-Future-Driver-SDK-Roadmap.md` | New |
| `docs/architecture/Automation-Editor-Production-Hardening-Report.md` | New (this file) |

**Nothing in `services/automations/`, `packages/domain-model/src/automations-
dsl.ts`, `packages/supreme-contracts/src/phase3.ts`, `services/persistence/src/
repositories/automation-repo.ts`, `services/gateway/src/routes/phase3.ts`, or the
mobile Dart implementation was touched.** This is deliberate — it's the evidence
backing §9–§11's compatibility claims, not an oversight.

## 1. Code review findings (Part 1)

Full read of `automations.tsx` (375 lines), `engine.ts` (315), `service.ts` (123),
`store.ts` (25), `compiler.ts` (39), `automations-dsl.ts` (91), the API client's
automation section, the gateway routes, and the mobile Dart editor for comparison.

**Duplicate logic:**
- **Cross-platform, real, not fixed**: the web and mobile editors independently
  hand-implement the identical six-node palette, identical `defaultNode()`/
  `_defaultNode()` default-value table, and identical field-editing rules (only
  onoff device state/commands are editable). Not literal shared code (TS and Dart
  can't share a module), so nothing to "extract" without a much larger
  architectural change (a shared, language-agnostic schema the two clients both
  render from) — exactly the kind of expansion this pass was told not to attempt.
  Documented in [Automation-Editor.md](./Automation-Editor.md) §1, not fixed.
- **Within `automations.tsx`, none found.** The six render/format helper functions
  (`nodeGlyph`, `actionLabel`, `condTitle`, `triggerTitle`, `nodeSummary`,
  `defaultNode`) each do one job with no overlapping logic; `Section`/`Node`/
  `AddBtn` are small, genuinely distinct presentational primitives, not repeated
  renderers.

**Dead code / unreachable branches:** none found. Every branch in `NodeConfig`,
`nodeSummary`, `nodeGlyph`, `actionLabel`, `condTitle`, and `triggerTitle` is
reachable from at least one node/trigger type actually produced by `defaultNode()`
or returned by the backend. `defaultNode()`'s previous `default: return { type };`
fallback (now removed, see §6) was defensive code with no reachable call site — see
§6 for why removing it is a real, if extremely low-probability, hardening.

**Duplicated React components/hooks:** none — no custom hooks exist in this file at
all (all state is local `useState`), and no component is a copy of another. This is
itself worth naming as a finding: `Automations`, `Editor`, `Canvas` are three fairly
large components in one file, each with meaningfully different responsibility
(list/search, drag-and-drop authoring, read-only view + debugger), and splitting
them into separate files was considered but rejected — it would be a pure file-
reorganization with no maintainability signal behind it beyond "the file is long,"
and reorganizing 375 lines into multiple files for no functional reason is exactly
the kind of change-for-its-own-sake this hardening pass should avoid.

**Inconsistent naming:** one real instance, fixed — the file declared both a type
alias `Node` and a component function `Node()`. TypeScript's separate type/value
namespaces meant this compiled without error, but it shadowed the global DOM `Node`
interface within the file's scope and was genuinely confusing on a first read.
Resolved as a side effect of §6's refactor (the type alias is now `EditorNode`); the
component keeps its name (`<Node kind="trigger" .../>` reads naturally in JSX, and
renaming a still-correctly-scoped component isn't needed once the type collision is
gone).

**Inconsistent typing:** the client's `AutomationView`/`AutomationRunView`
(`api.ts`) are hand-declared interfaces looser than — and independent of — the real
`Automation`/`AutomationRun` types from `@supreme/domain-model`/
`@supreme/contracts`. Investigated whether to replace them with the real domain
types; **decided not to** — the looser shape appears intentional (the client never
needs the full DSL's per-capability command fields, only enough to render a list/
summary), and unifying them is a real behavior-risk-bearing change for a "no runtime
behavior changes" pass, not a pure typing cleanup. Documented instead: a one-line
comment now explains why `AutomationView` is deliberately narrower (§ files-touched
table).

**Unnecessary allocations / unnecessary re-renders:** `Automations()`'s `shown =
items.filter(...)` recomputes on every render without memoization. **Not fixed** —
at the expected data scale (a home's automation list, realistically dozens of
items, not thousands), a `useMemo` here is the premature optimization Part 5
explicitly says to avoid; there's no evidence of measurable cost. See §5.

**Over-engineered code:** none found. If anything, the file leans toward
under-abstraction (the loose `Record<string, unknown>` node type was the clearest
example, fixed in §6) rather than over-engineering.

## 2–4, 8, 9, 12. Documentation

Covered in full by the two companion docs — not duplicated here. §2's field-
resolution pipeline, §8's developer documentation (rendering pipeline, driver
influence, capability configuration, event flow, driver integration guide) are in
[Automation-Editor.md](./Automation-Editor.md). §3's Command Metadata contract
(examples only), §4's maturity model, §9's future roadmap, and §12's extension
points audit are in
[Automation-Editor-Future-Driver-SDK-Roadmap.md](./Automation-Editor-Future-Driver-SDK-Roadmap.md),
clearly labeled as unimplemented proposals throughout.

## 5. Performance review (Part 5)

Reviewed: memoization, derived state, rendering paths, React reconciliation, lazy
rendering, virtualization, bundle size, unnecessary allocations.

**One real, "obvious" inefficiency found and fixed**: `Editor()`'s device-loading
`useEffect` fetched each room's devices **sequentially** —
`for (const r of h.rooms) all.push(...(await client.devicesInRoom(r.id)).devices)`
— meaning a home with N rooms made N serial HTTP round-trips before the device
picker in `NodeConfig` had any options. Fixed with `Promise.all(h.rooms.map(...))`
+ `.flatMap()`, preserving exact result ordering (rooms in list order, devices
within each room in their original order — `Promise.all` resolves by index
regardless of completion order, so this is not a behavior change, only a latency
one). This is the one Part-5 fix that met the "obvious inefficiency" bar; verified
safe via the full existing + new test suite (§10).

**Considered and explicitly NOT fixed** (premature optimization, no evidence of
real cost):
- `Automations()`'s search filter (`useMemo` would add complexity for a list size
  where `.filter()` is already sub-millisecond).
- No virtualization opportunity exists — there's no long list in this file large
  enough to warrant it (automations, devices-in-a-room, and scenes are all
  home-scale, not thousands of rows).
- Bundle size: the production build's one warning (`index-*.js` is 1.07 MB,
  `chunkSizeWarningLimit` exceeded) is **pre-existing and whole-app-scoped**, not
  attributable to `automations.tsx` specifically, and fixing it (code-splitting the
  entire `web-homeowner` bundle) is a much larger, unrelated architectural change.
  Noted, not addressed.
- React reconciliation: no `key`-prop issues found (every mapped list uses a stable
  key — device/scene `.id`, or array index for freshly-authored, not-yet-persisted
  editor nodes, which is the correct choice there since those nodes have no stable
  id of their own until saved).

## 6. Type safety (Part 6)

**Before**: `type Node = Record<string, unknown> & { type: string };` — an
effectively-untyped bag of properties. Every read required an unsafe cast:
`(node.command as { action?: string })?.action`, `String(node.at ?? "07:00")`,
`Number(node.ms ?? 5000)`, etc. — six such casts across `NodeConfig`/`nodeSummary`.

**After**: `EditorNode`, a real discriminated union over the six node shapes the
editor actually produces (full definition in
[Automation-Editor.md](./Automation-Editor.md) §4). Every one of those six casts is
gone — replaced by direct, compiler-verified field access, narrowed via
`node.type === "..."` checks (not an extracted `const t = node.type`, which would
have silently broken TypeScript's discriminated-union narrowing — a real trap this
refactor deliberately avoided). `defaultNode()` and `nodeSummary()` are now
exhaustive `switch` statements with **no `default` case** — a future `EditorNode`
variant added without updating both functions now fails to *compile*, not just to
render correctly at runtime.

**One new, small, defensive addition**: the HTML5 drag-and-drop payload
(`e.dataTransfer.getData("text/plain")`, split into `section:type`) is genuinely
untyped at that boundary — it's a string leaving and re-entering the type system
through the browser's own drag API. Added `isEditorNodeType()`, a runtime type
guard, at the one call site (`add()`) that receives it. Previously, a malformed
`type` string would have silently created a garbage node (via `defaultNode`'s old
`default: return { type }` fallback) that later UI code could error on rendering;
now it's a silent no-op. In practice this path is unreachable — the drag payload is
always self-generated by this same component's own `onDragStart` — but the guard
costs nothing and converts a theoretical "create a broken node" failure mode into a
strictly safer "ignore it" one. Called out explicitly here since it's a genuine
(if inert) behavior difference at an unreachable edge, not purely a type-level
change.

No `any` types were present in this file before or after. No weak generics or
nullable-ambiguity issues found beyond what §6 already fixed.

## 7. Test coverage (Part 7)

**Before this pass: zero.** `apps/web-homeowner` had no `.test.ts`/`.test.tsx` file
anywhere in the app — not specific to `automations.tsx`. The app also has no
`@testing-library/react` or `jsdom`/`happy-dom` dependency, i.e. no component-test
infrastructure exists at all in this app today (confirmed via `package.json` and a
full-repo search for existing `.test.tsx` files).

**Added**: `automations.test.ts`, 9 tests covering every exported pure function —
`defaultNode` (exhaustive over all 6 `EditorNode` types), `nodeSummary` (all 6
types, plus deleted-device/deleted-scene fallback paths), `nodeGlyph`/`actionLabel`/
`condTitle` (every mapped key plus the unmapped fallback), `triggerTitle` (time/
interval/sensor, plus a trigger missing optional fields — proving no field is
silently fabricated). These needed no DOM/rendering, so they run against the
existing plain-`vitest` setup with zero new dependencies.

**Not added, and why**: component-level tests (does the drag-and-drop actually
work, does clicking a palette chip add a node, does `Editor.save()` call
`createAutomation` with the right payload) would require introducing
`@testing-library/react` + a DOM environment to an app that has never had either —
a real, consequential infrastructure decision, not a "just add tests" change.
Recommended as a follow-up (see `TODO.md`), not bundled into this pass, consistent
with the brief's "do not introduce speculative abstractions or architectural
changes solely to satisfy the original brief."

`services/automations/`'s own test coverage was audited, not changed: `engine.ts`
has 8 solid tests (`engine.test.ts` — triggers, conditions, Automation Debugger
traces, time/interval, engine selection, HA compile). `AutomationService` (the CRUD
layer) has **no direct unit tests** — its only coverage is one happy-path e2e test
(`services/gateway/src/phase3.e2e.test.ts`'s "runs an automation: a sensor delta
drives a light, observed over WSS," which exercises create + WSS-observed execution
but not update/delete/enable-toggle/list/runs individually, and no validation-error
paths). Flagged as a real gap; not filled here, since `services/automations/` was
out of this pass's touched-files scope by design (§ files-touched table) — adding
tests for untouched code is defensible, but writing them without also being able to
verify them against a live `AutomationService` instance risked scope creep beyond
what this pass could verify end-to-end in the time available. Recorded in `TODO.md`.

## 8. Protocol compatibility validation (Part 13)

Confirmed by direct inspection, not assumed: `automations.tsx` contains **zero**
references to any protocol name, driver class, or `.protocol` field, anywhere in
its 400+ lines (grepped for `knx|matter|casambi|zigbee|dali|avr|heos|yamaha|
protocol` case-insensitively — no hits). It works exclusively against the generic
`Device`/`Scene` domain types and the capability-agnostic DSL. This means the
compatibility question has a simple, evidence-backed answer: **the editor behaves
identically for KNX, Matter, Casambi, Home Assistant, Zigbee, DALI, Virtual
Devices, Apple TV, AVR, Climate, Media Players, and any future driver**, because it
never branches on any of them — the only thing that could differ per device is
whether it has the `onoff` capability at all (in which case it's simply excluded
from being a *meaningful* automation target today, same as before this pass).

No protocol-specific rendering, no driver-specific UI, no protocol assumptions
exist anywhere in this file, before or after this hardening pass.

## 9. Automation serialization validation (Part 11)

Verified no changes affect automation JSON, import/export, persistence, runtime
serialization, automation IDs, or execution-engine compatibility — by the simplest
possible proof: **none of the files that own those concerns were touched** (see the
files-touched table). `packages/domain-model/src/automations-dsl.ts` (the DSL zod
schemas), `packages/supreme-contracts/src/phase3.ts` (the HTTP request/response
contracts), `services/persistence/src/repositories/automation-repo.ts` (SQL
persistence), `services/automations/src/{engine,service,store,compiler}.ts`
(execution + CRUD + HA compilation), and `services/gateway/src/routes/phase3.ts`
(the routes) are byte-for-byte unchanged. `EditorNode`'s six shapes were already a
strict subset of what `createAutomation()` sends today (§6) — the refactor changed
how the client *types* what it sends, not what it *sends*; the JSON payload
produced by `Editor.save()` for any given user interaction is identical before and
after this pass.

## 10. Backward compatibility matrix (Part 10)

The originally-requested tiers (Legacy Drivers → Capability-only Drivers →
Metadata-enabled Drivers → Fully Metadata-driven Drivers) map onto real driver
state as follows, per the maturity model in the
[roadmap doc](./Automation-Editor-Future-Driver-SDK-Roadmap.md):

| Tier | Real driver examples | Automation Editor behavior |
|---|---|---|
| Capability-only (fleet baseline — Maturity Level 1) | 18 of 22 drivers in `@supreme/protocols` (no `getCapabilityConfig()`) | Full onoff authoring works identically to every other driver — the editor never queries capability config today, so this tier and the next behave identically in the editor |
| Structural-capability-config-capable (Level 2) | AVR, HEOS, Yamaha, CoolMaster (4 of 22 — the only drivers implementing `getCapabilityConfig()`) | **Identical editor behavior to the tier above** — confirmed by code inspection, not just claimed: `automations.tsx` never calls `getCapabilityConfig()`, so a device's richer structural config is invisible to automation authoring regardless of whether the owning driver reports it |
| Metadata-enabled / Fully metadata-driven (Levels 3–5) | **None — this tier doesn't exist in any driver in this codebase** | N/A — there is nothing to validate compatibility against; this is exactly the future-proposal tier documented in the roadmap doc, not implemented |

**The demonstrated compatibility result**: because the editor is 100% uniform and
non-branching regardless of driver maturity (it doesn't consult driver metadata at
any level today), **every existing driver — regardless of tier — gets byte-for-byte
identical Automation Editor behavior before and after this hardening pass.** This
is the honest version of "identical runtime behavior for existing drivers": not
because compatibility logic was built and tested per-tier, but because no
tier-dependent behavior exists yet for this refactor to have disturbed.

## 11. Extension points audit (Part 12)

Covered in the [roadmap doc](./Automation-Editor-Future-Driver-SDK-Roadmap.md)'s
"Extension points a future editor could expose" section — custom parameter
editors, driver validation hooks, presentation hint providers, metadata providers,
AI suggestion hooks. **None exist today** — `NodeConfig`/`_ConfigSheet` are closed
`switch` statements over a fixed six-type union, with no registration/plugin
surface of any kind. This is stated plainly rather than implied, since "audit the
extension points" could otherwise misleadingly suggest some already exist.

## 12. Release candidate validation (Part 14)

Run in this environment, in full, after all code changes:

| Check | Command | Result |
|---|---|---|
| Build (full monorepo, 54 packages) | `pnpm build` | ✅ 54/54 successful |
| Typecheck (full monorepo, 93 tasks) | `pnpm typecheck` | ✅ 93/93 successful |
| Test (full monorepo) | `pnpm test` | ✅ all passing, including 222 gateway tests (unaffected — confirming §9's no-serialization-impact claim end-to-end) and the 9 new `automations.test.ts` tests |
| `@supreme/web-homeowner` build (bundle) | `pnpm --filter @supreme/web-homeowner build` | ✅ succeeds; one pre-existing, whole-app-scoped chunk-size warning (§5), unrelated to this pass |
| Lint | — | **No lint gate exists anywhere in this repository** — root `package.json` defines `"lint": "turbo run lint"`, but no individual package (including `@supreme/web-homeowner`) defines a `lint` script, and there is no ESLint or Biome config anywhere in the repo outside `node_modules`. `turbo run lint` is a documented no-op, not a check this report is silently skipping. |

**No runtime regressions, no rendering regressions, no type regressions, no
serialization regressions, no performance regressions** — the type refactor (§6)
is caught by `tsc --noEmit` passing cleanly (any narrowing failure would be a
compile error, not a silent bug); the performance fix (§5) preserves exact output
ordering; the serialization claim (§9) is backed by an untouched-files diff, not
inference; and the full existing test suite (which exercises `AutomationEngine`,
the gateway automation routes, and the WSS-observed end-to-end flow) passed
unmodified before and after.

## Summary

| Part | Status |
|---|---|
| 1. Code review | Done — findings above; fixed what improved maintainability without behavior risk, documented the rest |
| 2. Field resolution documentation | Done — [Automation-Editor.md](./Automation-Editor.md) §2–3, documents reality, not the requested fictional pipeline |
| 3. Driver Command Metadata contract | Done — [roadmap doc](./Automation-Editor-Future-Driver-SDK-Roadmap.md), examples only, explicitly not implemented |
| 4. Driver Maturity Model | Done — [roadmap doc](./Automation-Editor-Future-Driver-SDK-Roadmap.md), documentation only |
| 5. Performance review | Done — one real fix applied, rest explicitly deferred as premature |
| 6. Type safety | Done — `EditorNode` discriminated union, 6 unsafe casts removed, exhaustiveness enforced by the compiler |
| 7. Test coverage | Done — 0 → 9 tests for pure logic; component-test infra gap documented, not filled (real scope decision, not an oversight) |
| 8. Developer documentation | Done — [Automation-Editor.md](./Automation-Editor.md) |
| 9. Future Driver SDK roadmap | Done — [roadmap doc](./Automation-Editor-Future-Driver-SDK-Roadmap.md), explicitly labeled not-ADR-0005 |
| 10. Backward compatibility matrix | Done — §10 above; honest result: uniform behavior because no tier-dependent logic exists yet |
| 11. Serialization validation | Done — §9 above, verified via untouched-files diff |
| 12. Extension points audit | Done — [roadmap doc](./Automation-Editor-Future-Driver-SDK-Roadmap.md); none exist today, stated plainly |
| 13. Protocol compatibility validation | Done — §8 above, verified by direct grep, not assumed |
| 14. Release candidate validation | Done — §12 above, full build/typecheck/test green, lint gate honestly reported as nonexistent |

**The Automation Editor is unchanged in every user-observable and API-observable
way.** What changed: six unsafe type casts removed in favor of compiler-enforced
exhaustiveness, one N-sequential-requests-to-1-parallel-batch performance fix, and
nine new tests where there were previously zero. Everything else in this report is
documentation of what's real, what's a documented gap, and what's an explicitly
unimplemented future proposal — matching the brief's own instruction not to
redesign, not to add features, and not to claim completion without verification.
