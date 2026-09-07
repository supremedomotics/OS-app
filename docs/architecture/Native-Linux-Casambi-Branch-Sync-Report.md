# Repository Synchronization Report — `native-linux` ⟵ `claude/casambi-driver-refactor-lvu23e`

## Was `native-linux` behind?

**Yes, partially.** `native-linux` was missing 4 commits that existed on
`claude/casambi-driver-refactor-lvu23e` (merge-base `7ce9db9`). Of those 4, 2 were
pure-documentation audits with zero conflict, 1 was a clean application-code fix, and 1
targeted an architecture `native-linux` had already independently replaced with something
newer and more complete — that one was **not** cherry-picked wholesale, for reasons
detailed below, with only its two orthogonal, non-architecture-coupled fixes ported.

## Commit-by-commit comparison

**Unique to `native-linux`** (11 commits, `origin/claude/casambi-driver-refactor-lvu23e..origin/native-linux`) — the entire native Linux deployment body of work: `5fbb338` (native-linux deployment scaffold), `417a24b`/`492e797` (HA dependency audit), `d96ee90` (backend-from-HA-answer derivation), `bc000dd` (ADR-0023 Native Device Lifecycle — the Provider architecture), `edd37c0`/`d7d67c0`/`b064069` (ADR renumbering + merges), `ede50ae` (RC-1 production hardening), `d985748`/`4bdbc7f` (installer runtime-context fixes). None of these exist on the casambi branch — they are `native-linux`'s own, independent line of work and are untouched by this sync.

**Unique to `claude/casambi-driver-refactor-lvu23e`** (4 commits) — evaluated individually below.

| Commit | Summary | Files changed | Disposition |
|---|---|---|---|
| `58ecdf8` | Make Home Assistant an optional compatibility plugin; native engine default | 23 files (`routing-adapter.ts`, `bootstrap.ts`, `home-service.ts`, `sil.ts`, new `ha-unavailable-adapter.ts`, automations engine/service, 2 new e2e tests, 2 new docs) | **Partially ported** — see §Architectural differences |
| `6d06520` | SupremeOS Core Capability Audit (research only) | 1 file (new doc) | **Ported clean**, no conflict |
| `29cd37c` | Capability Audit Phase 1: fabrication/silent-failure fixes | 18 files (voice platforms, HomeKit, KNX/Matter/SIP drivers, sensor UI, 1 new doc) | **Ported clean** (only `SESSION_HANDOFF.md`/`TODO.md` conflicted) |
| `cd0b6a3` | SupremeOS Production Readiness Audit (research only) | 3 files (new doc + handoff/TODO) | **Ported clean** (only `SESSION_HANDOFF.md`/`TODO.md` conflicted) |

## Files changed (this sync)

Application code: `packages/domain-model/src/automations-dsl.ts`, `services/automations/src/{engine,engine.test,service}.ts`, `services/gateway/src/{config,config.test}.ts` (from `58ecdf8`'s portable subset), plus everything `29cd37c` touched: `apps/web-homeowner/src/device-sheets.tsx`, `cloud/voice/src/{alexa,google}.ts` (+ new tests), `services/gateway/src/{context,knx-installer-workflow.e2e.test}.ts`, `services/homekit/src/bridge.ts` (+ test), `services/protocols/src/knx/capability-mapper.ts` (+ test), `services/protocols/src/matter-driver.ts` (+ test), `services/protocols/src/sip-driver.ts` (+ test).

Documentation: 3 new audit docs (`SupremeOS-Core-Capability-Audit.md`, `SupremeOS-Core-Capability-Audit-Phase1-Fixes.md`, `SupremeOS-Production-Readiness-Audit.md`), plus this report; `SESSION_HANDOFF.md` and `TODO.md` updated (see §Conflicts).

## Conflicting files and resolution

**`SESSION_HANDOFF.md` / `TODO.md`** conflicted on 3 of the 4 cherry-picks (`6d06520` was clean). In every case the conflict was purely additive — both branches had appended new session entries/backlog items to the same location since diverging, never edited the same line. Resolution: keep both sides' content, `native-linux`'s sync-summary entry first (most recent), then the incoming entries in their original order, with one substantive annotation added to `TODO.md`: the incoming "Reconcile the two unmerged core-architecture rewrites" Critical blocker item (found by the Production Readiness Audit itself) is now marked `~~...~~ RESOLVED by repository sync`, since resolving exactly that question is what this sync accomplished. No other conflicting file existed — every application-code file in `29cd37c` (including `services/gateway/src/context.ts`, touched by both branches) auto-merged with zero manual intervention, confirmed by a dry-run cherry-pick before any real changes were made.

## Architectural differences — why `58ecdf8` was not cherry-picked wholesale

A dry-run cherry-pick of `58ecdf8` produced 6 content conflicts and 2 modify/delete conflicts (`routing-adapter.ts`, `routing-adapter.test.ts` — modified on the casambi branch, **deleted** on `native-linux`). This is not incidental: `cd0b6a3`'s own Production Readiness Audit independently flagged it as Critical Blocker C1 — *"two incompatible, unmerged core-architecture rewrites of device lifecycle exist simultaneously."*

- `claude/casambi-driver-refactor-lvu23e` extended the **`RoutingBackendAdapter`/`OwnershipRegistry`** model: an `ha` slot that got either a real `HaAdapter` or a fallback (previously silent `MockAdapter`, fixed in `58ecdf8` to an honest `HaUnavailableAdapter`).
- `native-linux` (`bc000dd`, ADR-0023 "Native Device Lifecycle Architecture") independently **deleted that entire model** and replaced it with `ProviderRegistry` + `DriverBindingEngine` + `ProviderRouter` — confirmed by reading `provider-router.ts`'s own docstring: *"the complete, non-wrapping replacement for `RoutingBackendAdapter`... never assumes any particular provider (including Home Assistant) is present... fails loudly with its real lifecycle state; nothing routes around that by falling back to a simulator."*

These pursue the *same underlying goal* (no fabricated fallback state, Home Assistant genuinely optional, native-first by default) via two incompatible mechanisms designed independently, in parallel, without either branch aware of the other. Per this sync's explicit rules ("do not modify application architecture," "never overwrite native-linux specific deployment changes," "preserve native-linux as the long-term production branch"), the correct resolution is that `native-linux`'s ADR-0023 architecture wins outright — it is the more complete, more recently-designed, already-battle-tested replacement, not a peer to be merged with the older one.

Excluded from `58ecdf8`, and why each is specifically not applicable:

- **`services/integration-layer/src/routing-adapter.ts` + `.test.ts`** — the file `native-linux` already deleted. Resurrecting it would directly reverse `native-linux`'s own architectural work.
- **`services/integration-layer/src/ha-unavailable-adapter.ts` + `.test.ts`** (new files) — only ever wired into `bootstrap.ts`'s `routing-adapter.ts`-based construction path, which no longer exists on `native-linux`. Bringing the file over with nothing to wire it into would add dead code.
- **`services/gateway/src/bootstrap.ts`, `installer-context.ts`** — both conflict directly; their `58ecdf8` diffs construct the now-deleted `RoutingBackendAdapter`/`HaUnavailableAdapter` three-way selection. `native-linux`'s equivalent wiring already constructs `ProviderRouter`.
- **`services/home/src/home-service.ts`** (ownership-default fix) — `58ecdf8` fixed `bind()` defaulting ownership to `"ha"` unconditionally. Verified by direct inspection: `native-linux`'s `home-service.ts` no longer has an ownership-inference concept at all — `bind()` requires an **explicit** `provider` (ADR-0023 § Commissioning: "Commissioning flow explicit provider assignment"). The bug this fix targeted cannot exist in the current architecture; there is nothing to port.
- **`services/integration-layer/src/sil.ts`** (`primeState()` centralization) — conflicts because it's wired against the old adapter construction; `native-linux`'s `sil.ts` has its own, independently-built state-priming path through `ProviderRouter`/`ProviderRegistry`.
- **`services/gateway/src/{native-backend-boot,device-status-reconciliation}.e2e.test.ts`** (2 new test files) — confirmed by reading their imports: both directly import `RoutingBackendAdapter` from `@supreme/integration-layer`, a symbol that no longer exists on `native-linux`. These would fail to *compile*, not just conflict — bringing them over verbatim would break the build.
- **`docs/architecture/Native-Backend-Implementation.md`, `docs/architecture/adr/0023-native-backend-default.md`** — document the now-superseded architecture in detail (and the ADR file collides in number with `native-linux`'s own, different `0023-native-device-lifecycle-architecture.md`). Not brought over; `native-linux`'s own ADR-0023 doc is the authoritative one.

**What *was* ported from `58ecdf8`** (confirmed self-contained by reading every hunk, not just by a clean git-merge): `packages/domain-model/src/automations-dsl.ts`, `services/automations/src/{engine,service,engine.test}.ts` (reject `engine: "ha"` automations at creation; a legacy row reports `health() === "broken"`) and one line in `services/gateway/src/config.ts`'s `assertSecureConfig()` (+ its `config.test.ts` coverage) refusing `SUPREME_BACKEND=mock` in production. Neither references the adapter-routing layer at all.

## Deployment differences

None — no file under `infra/native-linux/`, `infra/hub-compose/`, `infra/systemd/`, or `.github/workflows/` appears in any of the 4 casambi-branch commits. Docker development support is untouched by this sync in both directions.

## Documentation differences

Fully reconciled: all 3 audit documents from the casambi branch now exist on `native-linux`, and `SESSION_HANDOFF.md`/`TODO.md` carry every entry from both branches plus this sync's own summary and the resolution note on the Critical Blocker C1 backlog item.

## Requirement 6 — verified present on `native-linux` after this sync

- **Native Linux deployment** — unaffected, all 11 `native-linux`-unique commits preserved verbatim.
- **Supreme LAN architecture** — `infra/systemd/supreme-lan.service` and `services/lan/` untouched by every commit compared in this sync (none of the 4 casambi commits touch LAN code).
- **Native Backend** — already present and, per the architectural analysis above, more complete on `native-linux` than on the casambi branch (`ProviderRouter` vs. `RoutingBackendAdapter`+`HaUnavailableAdapter`).
- **Home Assistant dependency reduction** — present via ADR-0023's Provider architecture (HA is one more `INativeProtocolDriver`, never a required leg) plus the newly-ported `engine: "ha"` automation rejection and mock-backend production refusal.
- **Casambi improvements** — none of the 4 compared commits touch Casambi code; nothing to sync in either direction on this axis for this specific comparison.
- **Capability fixes** — `29cd37c`'s full fabrication/silent-failure fix set now present.
- **Production Readiness fixes** — the audit itself is now present as a tracked, cross-referenced backlog (`TODO.md` Critical section), with its #1 finding (the branch-fork question) resolved by this very sync and documented as such.
- **Every production-safe improvement completed after divergence** — all 4 commits accounted for; 3 fully ported, 1 partially ported with an explicit, evidence-based exclusion rationale for the rest.

## Verification results

`bash -n` was not relevant here (no shell scripts touched). Full monorepo verification —
`pnpm turbo run build typecheck test` — was run after all 4 commits landed; see the
companion commit/PR for the captured pass/fail output at the time of this sync. Every
individual package touched by the ported commits (`@supreme/domain-model`,
`@supreme/automations`, `@supreme/gateway`) was independently build/typecheck/test-verified
during development of the `58ecdf8` partial-port commit, before the full-workspace run.

## Remaining differences between `native-linux` and `claude/casambi-driver-refactor-lvu23e`

After this sync, `native-linux` is **ahead** of `claude/casambi-driver-refactor-lvu23e` by
every commit in both directions except the architecture the casambi branch never got:
`RoutingBackendAdapter`/`OwnershipRegistry`/`HaUnavailableAdapter` exist only on
`claude/casambi-driver-refactor-lvu23e`, superseded on `native-linux` by ADR-0023's Provider
architecture. This is not a gap to close — it is the resolved outcome of Critical Blocker
C1. No further reconciliation work is expected unless a future casambi-branch commit adds
new functionality on top of the now-superseded adapter layer, which would need the same
case-by-case portability analysis this report applied.
