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

## AI Operating Instructions

Permanent workflow rules for every future Claude Code session on SupremeOS — these apply on top
of, not instead of, the Workflow steps above.

- **Read before acting.** Read `CLAUDE.md`, `PROJECT_CONTEXT.md`, `SESSION_HANDOFF.md`, and
  `TODO.md` before making any changes.
- **Inspect before creating.** Read the existing implementation of the area you're touching
  before creating new files or components — these docs summarize, they don't replace reading the
  actual code.
- **Reuse over rebuild.** Reuse existing components, services, utilities, hooks, types, and
  design tokens whenever possible rather than writing a new one that duplicates existing
  behavior.
- **Extend, don't fork.** Prefer extending the current architecture over creating a parallel
  implementation of something that already exists.
- **Backward compatibility by default.** Maintain backward compatibility unless explicitly
  instructed otherwise.
- **Docs track code.** Keep documentation synchronized with implementation as you go.
- **Verify, never fabricate.** Never fabricate repository facts — capabilities, file locations,
  architecture, status — verify by inspecting the actual code first.
- **Before ending every development session:**
  - Update `SESSION_HANDOFF.md`.
  - Update `TODO.md`.
  - Record completed work.
  - Record architecture decisions made.
  - Record known issues and blockers.
  - Record recommended next steps.

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

## Autonomous development environment (Claude Desktop)

This section documents the local MCP-driven dev environment configured for this workstation
(`%APPDATA%\Claude\claude_desktop_config.json`), so any future session — Desktop or Code — knows
what tools exist, how to use them correctly, and their real limitations. Nothing here is
aspirational; every claim was validated against a real MCP handshake or a real command run on
this machine.

### Available MCP servers

| Server | What it actually is | Real scope |
|---|---|---|
| `filesystem` | `@modelcontextprotocol/server-filesystem` (Anthropic reference, native) | Read/write access to `G:\Documents\Claude Projects\OS-app` only |
| `playwright` | `@playwright/mcp` (Microsoft, native) | Runs as a real process on this machine — can reach `localhost`/LAN IPs directly (unlike a cloud-sandboxed browser tool). Screenshots/traces write to `.claude/playwright-output/` |
| `terminal` | `@wonderwhy-er/desktop-commander` (native, **not** the sandboxed Docker-catalog variant) | Real shell access with `docker`, `git`, `pnpm`, `node` on `PATH`. `allowedDirectories` restricted to `G:\Documents\Claude Projects\OS-app` (config lives at `~/.claude-server-commander/config.json`, not settable via a CLI flag) |
| `git` | official `mcp-server-git` via `uvx --python <standalone Python 3.12>` | Repository-scoped to `OS-app` |

**Docker MCP Toolkit exists on this machine** (`docker mcp` CLI plugin, 315-server catalog) but is
**deliberately not configured** — every catalog server (including its own Desktop Commander
build) runs sandboxed inside its own container with no host Docker-socket access, so it cannot
rebuild or inspect this project's actual containers. The native `terminal` server above already
does this correctly; adding the Toolkit gateway would only duplicate shell-execution capability
through a more restricted transport. Re-evaluate only if Docker ships a catalog server explicitly
granting host-socket access.

### URL discovery workflow (browser testing)

**Never hardcode `localhost` or an IP** when testing the running app. Before every browser
session:

1. Confirm the stack is up: `docker compose -f infra/hub-compose/docker-compose.yml ps` (or
   `docker ps --filter name=supreme-hub`) — look for `supreme-hub-proxy-1` running.
2. Get the current LAN IPv4: `ipconfig` (Windows) → the active adapter's IPv4 Address (this
   machine's address changes between networks — never assume a prior session's value is still
   correct).
3. Probe in this order, using the first that responds: `https://<LAN-IP>` → `https://localhost` →
   `http://<LAN-IP>` → `http://localhost`. HTTPS first because Caddy terminates TLS there (see
   `infra/hub-compose/Caddyfile`); HTTP is the redirect-only fallback.
4. Only then open that URL in Playwright.

This exists because Caddy's TLS setup uses an on-demand internal-CA policy keyed to whatever
`Host`/SNI the client presents (see `infra/hub-compose/Caddyfile`'s `:443` catch-all) — the LAN
IP is not fixed infrastructure, it's whatever this machine's current network assigns it.

### Docker rebuild workflow

Whenever a code change requires a container rebuild, **rebuild only what changed** — never
`docker compose up --force-recreate` the whole stack for a one-service change (confirmed
elsewhere in this session: a full `--force-recreate` cascades to unrelated services like
`mqtt`/`nats`/`homeassistant` via the Compose dependency graph, which is unnecessary churn for a
scoped change):

```powershell
cd infra/hub-compose
docker compose build <service>              # e.g. homeowner, gateway, installer-portal
docker compose up -d --force-recreate <service>
docker compose ps                            # confirm it's Up, not Restarting
docker logs <container> --tail 50            # confirm no startup errors
curl -sk https://<discovered-URL>/healthz    # confirm the health endpoint responds before opening a browser
```

A bind-mounted config file (e.g. `Caddyfile`) changing does **not** need a rebuild — `docker
compose restart <service>` restarts the process only. But if the container was already running
when the file changed, verify the mount actually picked it up (`docker exec <container> md5sum
<path>` vs. the host file) before trusting a `restart` — Windows Docker Desktop bind mounts have
been observed serving stale content after `restart` alone in this environment; `docker compose up
-d --force-recreate <service>` reliably refreshes the mount when in doubt.

### Browser validation workflow

After any frontend change, before reporting it done:

1. Discover the URL (above), rebuild/restart the relevant container if needed.
2. Open it in Playwright; wait for the app shell to render (not just HTTP 200 — confirm real DOM
   content, since a 200 with an empty root div is not "loaded").
3. Capture: console messages (filter for `error`/`warning`), failed network requests (4xx/5xx),
   and a screenshot at each responsive tier this project requires (~390px / ~834px / ~1440px /
   ~2560px — see UI & UX standards above).
4. If anything failed to load: read the console/network evidence first, form a hypothesis, check
   the relevant source file, and only then decide whether it's a code bug (fix it) or an
   environment issue (report exactly what's blocking, don't guess).

### Coding & debugging conventions

Same as the rest of this document — nothing here overrides `Development principles` or `Coding
standards` above. The one addition: prefer the `terminal` server's real command execution over
guessing at behavior; if unsure whether a change compiles, actually run `pnpm --filter
<package> typecheck`, don't assume.

### Known environment limitations (this workstation, recorded so nobody re-discovers them)

- `uv`'s own managed-Python downloader fails at the "minor version link" (junction-creation) step
  in this shell environment — this is bypassed by using a `winget`-installed standalone Python
  (`Python.Python.3.12`) and pointing `uvx --python <path>` at it explicitly. If `uv python
  install` is ever needed directly, expect this to fail the same way.
- Scripted (non-interactive) stdio calls to Desktop Commander's filesystem-touching tools
  (`read_file`, `list_directory`, etc.) do not reliably return a response — only in-memory tools
  like `get_config` do. This looks like an async initialization or permission-gate step that only
  a real GUI-driven MCP client satisfies. Config *changes* (editing
  `~/.claude-server-commander/config.json` directly, or via `set_config_value` from a live
  session) are reliable and persist across restarts; it's specifically scripted multi-turn
  *filesystem tool* verification that's unreliable.

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
