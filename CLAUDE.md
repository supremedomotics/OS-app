# CLAUDE.md — SupremeOS Permanent Instruction Manual

> This is the permanent, project-wide rulebook for every Claude Code session working on
> SupremeOS. It changes only when project-wide rules evolve — not for routine feature work.
> For "what's the current state" and "what should I work on," see `SESSION_HANDOFF.md` and
> `TODO.md`. For deep background on vision/architecture, see `PROJECT_CONTEXT.md`.

## Project identity

SupremeOS is a **luxury smart-home platform** by Supreme Domotics, built to compete with
Control4, Savant, Crestron, and RTI — not with Home Assistant or DIY smart-home apps. It is
**local-first** (the hub is a complete, self-sufficient product with zero internet dependency)
and **abstraction-first** (no client ever speaks a protocol directly — everything routes through
the Supreme Integration Layer). Full detail: `PROJECT_CONTEXT.md`.

## Workflow — start of every session

1. Read this file (`CLAUDE.md`).
2. Read `PROJECT_CONTEXT.md`.
3. Read `SESSION_HANDOFF.md`.
4. Read `TODO.md`.
5. Inspect the *actual* relevant code before changing anything — these docs summarize, they
   don't replace reading the file you're about to touch.
6. Preserve existing architecture unless there's a compelling, stated reason to change it.
7. Keep documentation synchronized with implementation as you go, not just at the end.

## Development principles

- **Production-quality only.** No placeholder logic, no "TODO: implement later" left in a path
  that looks finished. If something is genuinely not implementable yet, it must be *visibly*
  incomplete (see Capability Gating below), never silently faked.
- **Never fabricate data or capabilities.** This is the single most load-bearing rule in the
  codebase. A control only becomes live/interactive when a real capability + config/state field
  backs it. Everything else renders as an honest, gated placeholder. See `packages/domain-model
  /src/capabilities.ts` for the real capability vocabulary — never invent a new one to make a UI
  feature "work."
- **Capability-driven, never protocol-driven.** UI and services render/branch off Supreme
  capabilities (`onoff`, `brightness`, `media`, `lock`, …), never off a specific brand/protocol.
  Protocol-specific distinctions that have no capability equivalent (e.g. "is this a TV or a
  speaker") use an explicit, installer-entered `device.metadata` field — never a guess.
- **Modular, feature-module architecture.** New device UI lives under
  `apps/web-homeowner/src/features/<domain>/` owning its own capability mapper, Standard Card,
  Expanded Sheet, Premium Detail Page, icons, and actions. Don't scatter one device type's logic
  across unrelated files.
- **Maintainability and clean architecture first.** Reuse the shared component library
  (`@supreme/aureon-web`) and shared sections (`device-detail-sections.tsx`) rather than
  duplicating a pattern per page. If you improve a shared primitive, every consumer inherits it —
  that's the point; don't hand-roll a one-off "just for this page."
- **Strong typing.** TypeScript strict-mode conventions throughout; zod schemas in
  `domain-model`/`supreme-contracts` are the source of truth for shapes — don't redeclare a
  parallel type by hand when a schema-derived type already exists.
- **No unnecessary complexity, no speculative abstraction.** Don't build a plugin system for a
  feature with one implementation. Three similar lines beat a premature abstraction.
- **Never break working functionality.** Read `git status`/`git diff` before broad edits.
  Preserve backward compatibility unless a breaking change is explicitly requested and justified.
- **Security-first.** Never commit secrets. Treat all external/protocol input as untrusted at
  the SIL boundary. Follow existing patterns for auth (JWT/session handling in
  `services/identity`, `services/gateway/src/auth.ts`) rather than inventing new ones.
- **Performance-first.** Motion must be GPU-accelerated (`transform`/`opacity`, not
  layout-triggering properties) and respect `prefers-reduced-motion`. Avoid needless re-renders
  in hot device-state paths (`useLive()`/live WSS state).

## Coding standards

- **Folder organization:** device-specific web UI → `apps/web-homeowner/src/features/<domain>/`
  (e.g. `features/media/`, `features/security/`); shared design-system primitives →
  `packages/aureon-web/src/components/`; shared cross-page sections (Information, Diagnostics,
  Automations, History, Advanced Settings) → `apps/web-homeowner/src/device-detail-sections.tsx`.
  Backend: one directory per bounded service under `services/` (local hub) or `cloud/`
  (multi-tenant SaaS plane) — never mix the two.
- **Naming:** `PascalCase` for components/types, `camelCase` for functions/variables, kebab-case
  for file names matching their primary export's concept (e.g. `capability-mapper.ts`,
  `lock-detail.tsx`). Capability mapper files export a `<Domain>KindMeta`/`<domain>DeviceKind()`
  pattern — follow it for new device kinds rather than inventing a new shape.
  When a required distinction has no protocol signal, thread it through
  `device.metadata.<domain>.kind`, mirroring `climate-console.tsx`'s HVAC brand/unit-type
  pattern and the Media/Security modules' `kind` classification.
- **TypeScript conventions:** prefer types inferred from zod schemas (`z.infer<typeof X>`) over
  hand-written duplicates. Use `ReactNode` for props that may carry either an `Icon` element or
  plain text (see `QuickAction.icon`/`CapabilityGridItem.icon`) rather than a `string`-only prop
  when the field is rendered, not just used as a native-widget label.
- **API conventions:** `packages/supreme-contracts` defines every REST/WSS shape; the gateway
  (`services/gateway/src/routes/*.ts`) is the only client-facing surface. New endpoints go
  through the gateway, backed by a domain service — clients never call a domain service
  directly.
- **Error handling:** never let a raw exception reach a homeowner-facing UI string; wrap in
  `friendlyError()` (see `apps/web-homeowner/src/errors.ts`) or the service-level `SupremeError`
  contract. Backend errors use the shared error model in `supreme-contracts`.
- **Testing expectations:** `vitest` for TS services (co-located `*.test.ts`, e2e suites as
  `*.e2e.test.ts` in `services/gateway/src`), `pytest` for Python services, `flutter test` for
  Dart. New backend behavior needs a test in the same PR; new UI behavior should be
  Playwright-verified live (see `run` skill) before considering it done, not just typechecked.
- **Documentation standards:** comment only the non-obvious *why* (a hidden constraint, a
  workaround, an invariant) — never restate what well-named code already says. Module-level
  docstrings in this codebase consistently open with a `(§ Section Reference)` back to the
  architectural principle or ADR they implement — follow that convention, it's how future
  sessions trace a file back to its rationale.

## UI & UX standards — the Aureon design language

This is the **permanent, frozen** responsive/visual foundation. Do not introduce a second layout
system, a second icon set, or a second capability-gating pattern. Improve the shared primitives
in `packages/aureon-web`; every page inherits the improvement automatically.

- **Visual philosophy:** dark, architectural, gold-accented, room-first, restrained — never
  flashy. Every design decision should pass "would Apple Home / Sonos / Savant ship this?" Not
  Home Assistant, not Material UI, not a generic admin dashboard.
- **Design tokens:** the single source of truth is `packages/aureon-web/tokens/aureon.tokens.json`
  (mirrored to Flutter via `tools/codegen`). Colors: `--aureon-color-base-{void,surface,
  surface-raised,surface-overlay,hairline}`, `--aureon-color-gold-{50,200,400,500,600,700}`,
  `--aureon-color-text-{primary,secondary,muted,inverse}`, `--aureon-color-status-{good,info,
  warning,critical}`. Never hardcode a hex value in a component — route through these.
- **Typography:** fluid, clamp()-based scale — `--aureon-text-{caption,label,body,headline,
  title,display}`. Hero titles use the `title` token (28px), never a hardcoded font-size.
  `"Aureon Display"` font family for large hero numerals/headings, Inter for everything else.
- **Spacing:** fluid `--aureon-space-{xs,sm,md,lg,xl,xxl}` tokens, density-scoped (see below).
- **Density engine (responsive framework, frozen):** three tiers — `compact` (phones, small
  panels), `comfortable` (tablets), `expanded` (desktop/ultrawide/15"+ panels) — derived
  automatically from real viewport width via `useAureonDensity()` / the `data-density` attribute
  on `<html>`, never a device/browser sniff. `AUREON_BREAKPOINT = { comfortable: 700, expanded:
  1200 }`. New layout work reflows via CSS keyed on `[data-density="..."]`, not new breakpoints.
- **Elevation & cards:** `Card` (`aureon-web/components/Card.tsx`) is the base surface for every
  grouped content block. `standard`/`expanded` variants get a soft gradient border, a faint top
  highlight, and real box-shadow elevation; `compact` (dense repeated tiles — fact grids, gated
  placeholder grids) stays flatter on purpose so a busy grid doesn't turn into noise. Never style
  a bare `<div>` as a card from scratch.
- **Buttons & controls:** `Button`/`IconButton` have real hover glow, press-scale feedback, focus
  rings, and an opt-in `aria-busy` loading spinner (no new prop needed at call sites). Sliders,
  segmented controls, and the lock slide-gesture are shared primitives — reuse
  `SegmentedControl`/`SlideUnlock` rather than rebuilding the interaction.
- **Icons:** one SVG line-icon family, `packages/aureon-web/src/components/Icon.tsx` — 24×24
  viewBox, `stroke="currentColor"`, `strokeWidth 1.7`, round caps/joins. **Never use emoji in
  product UI.** Adding a new device/glyph concept is one entry in `Icon.tsx`'s `PATHS` map — no
  new component. The one sanctioned exception: a native `<select><option>` cannot render SVG, so
  capability-mapper `KindMeta` types carry both a plain-text `icon` (for that one native-widget
  context only) and an `iconName: IconName` (for every real surface — heroes, badges, chips).
- **Premium Device Experience pages** (device detail pages) follow this shape, established this
  cycle: a **hero** (the `.avr-now`/`.avr-art-wrap`/`.avr-halo` shell — a glowing, state-tinted
  icon plate or live-preview surface, sized generously, never a token-sized header bar) → real
  controls → **QuickActions** (context-specific action pills, real actions only) → **More
  controls** via **CapabilityGrid** → the five shared Universal Page Structure sections
  (Information / Diagnostics [devMode-gated] / Automations / History / Advanced Settings) laid
  out via `.aureon-detail-grid` (two columns at `expanded` density, one column below it — never
  stack everything into one long column on a desktop display).
- **Capability gating — "the UI is the contract":** a control the design calls for but no driver
  backs yet stays **visible**, renders **inert**, and is labeled with the real reason
  (`capabilityAvailability()` in `features/_shared/capability-availability.ts` — only three
  honest outcomes: available / "Not supported by current driver" / "Driver required"). Use
  `CapabilityGate` for a single standalone control, `CapabilityGrid` for a set of them — the grid
  auto-collapses every unavailable item into ONE quiet chip strip with ONE explanation, never a
  "Driver required" badge repeated per tile. Never delete a control from the design because the
  backend doesn't support it yet; gate it instead.
- **Motion:** subtle, GPU-accelerated, always with a `prefers-reduced-motion` fallback to `none`.
  Established vocabulary: ambient hero glow/halo pulse tied to real state (not decorative),
  hover-lift on interactive cards, press-scale on buttons, a heartbeat pulse on a genuinely live
  camera feed, a status-appropriate shudder on a genuinely triggered alarm, page-enter fade. Add
  to this vocabulary; don't start a new one.
- **Empty space:** large/ultrawide displays must feel curated, not stretched or sparse — content
  columns grow gently with viewport width (`min(1360px, 92vw)`) and center themselves; they
  don't pin to one edge with dead space beside them.
- **Accessibility:** every icon-only control needs `aria-label`; status communicated by color
  alone also gets a `StatusDot` with a `label`; respect reduced-motion; native `<option>` text
  stays a11y-plain (no SVG expected there).
- **Responsive requirement:** every UI change must be verified (not just typechecked) at phone
  (~390px), tablet (~834px), desktop (~1440px), and ultrawide (~2560px) — zero horizontal
  overflow, zero clipped controls, no broken layout at any tier. Use the `run` skill's Playwright
  pattern; screenshot and actually look at the result.

## Session completion checklist

Before ending every session:

- [ ] Update `SESSION_HANDOFF.md` with what changed, what's next.
- [ ] Update `TODO.md` — move finished items to Completed, add newly discovered work.
- [ ] Record any architectural decisions made (if significant enough, consider a new ADR under
      `docs/architecture/adr/`).
- [ ] Record newly discovered issues/gaps, even ones you didn't fix.
- [ ] Confirm `typecheck` and `build` pass for every package you touched.
- [ ] Confirm nothing was committed/pushed without explicit user request, per the git safety
      rules already governing this environment.
