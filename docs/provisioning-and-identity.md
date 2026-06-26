# Provisioning & Identity — Supreme OS owns the experience, HA is invisible

This documents how Supreme OS makes Home Assistant a **hidden internal automation engine**
with **zero installer interaction**: no `.env` token, no HA login, no HA UI — ever.

## Identity model

Supreme OS is the **only** identity and authorization provider.

```
Supreme Login ─▶ Supreme Identity Service ─▶ JWT / Session ─▶ Gateway
                                                                 │  (internal Docker network)
                                                                 ▼
                                              Hidden HA internal service account ─▶ Devices
```

- Homeowners and installers authenticate **only** with Supreme OS (Argon2id + JWT access/
  refresh + TOTP). Roles (Super Admin, Admin, Installer, Homeowner, Family, Guest, Service
  Engineer) and all authorization live in Supreme's permission engine.
- Home Assistant holds exactly **one** account: a hidden internal service account used
  solely by the gateway over the internal `supreme-core` network. No user ever sees it.
- Home Assistant never manages users, auth, authorization, installer/homeowner access, or
  any login UI. It does device integrations, entities, automations, protocols, discovery,
  and state — nothing else.

## Automatic first-boot provisioning

On first boot, when `SUPREME_BACKEND=ha` and no token is configured, the gateway resolves
the HA token in this order (`services/gateway/src/bootstrap.ts` → `resolveHaToken`):

1. **Explicit token** — `SUPREME_HA_TOKEN` (env / `*_FILE`), if you chose to pin one.
2. **Stored token** — a token minted on a previous boot, read from the secrets manager.
3. **Headless provisioning** — `provisionHaToken()` (`services/integration-layer/src/ha/
   ha-provisioner.ts`):
   1. `GET /api/onboarding` — detect whether HA is already initialized.
   2. If not: `POST /api/onboarding/users` creates the hidden internal owner
      (`admin` / `admin@supremeos` by default) → short-lived auth code.
   3. `POST /auth/token` exchanges the code for an OAuth access token.
   4. Best-effort completes the remaining onboarding steps (core config with the system
      name / time zone / location, analytics, integration) so HA's setup UI can never
      reappear.
   5. Opens the authenticated WS API and mints a **long-lived access token**
      (`auth/long_lived_access_token`, ~10-year lifespan).
   6. The token is stored in the secrets manager and injected into the SIL transport.

If HA was already onboarded by someone else (so we must not create a second owner), boot
fails with a clear message asking for a one-time `SUPREME_HA_TOKEN` — we never silently
create conflicting accounts.

The whole flow is confined below the SIL boundary (the `ha/` folder). Nothing above the
SIL learns that onboarding happened.

## Setup Wizard (first-run administrator)

In production (`SUPREME_SETUP_WIZARD=1`, the compose default) the hub does **not** seed a
demo owner on first boot. Instead it comes up in a "setup required" state serving only
`/healthz` and the wizard endpoints, until the installer creates the Supreme OS
administrator:

- `GET /v1/setup/status` → `{ setupRequired, systemName }` — drives the client onboarding.
- `POST /v1/setup` `{ username, password, confirmPassword, systemName, location?, timeZone? }`
  → creates the administrator + home, brings the rest of the stack online, and returns an
  authenticated session so the wizard lands logged in. Replays return `409`.

The administrator is a **Supreme OS** account only — no matching Home Assistant user is
ever created; the gateway keeps using HA's hidden internal service account. The wizard
mirrors the flow: Welcome → Create Administrator → Username → Password → Confirm → System
Name → Location → Time Zone → Finish. (Backend is complete; the Flutter/web wizard screen
binds to these two endpoints.)

Dev and tests leave `SUPREME_SETUP_WIZARD` unset, so they keep auto-seeding the demo owner
(`owner@supreme.local`) and the e2e suites are unaffected.

## Secrets manager

`services/gateway/src/secrets.ts` persists runtime-generated secrets (the HA token) as
`0600` files under `SUPREME_SECRETS_DIR` (a Docker volume, `supreme-secrets:/data/secrets`
in compose), so a provisioned hub reconnects on reboot with no re-provisioning. Without a
directory configured (dev/tests) it degrades to in-memory. Secrets supplied via env /
`*_FILE` continue to be honoured by config; this is purely the write-back path for
generated secrets.

## Developer Mode (off by default)

Production keeps HA fully hidden — **no published ports**. For debugging only, the
`docker-compose.dev-mode.yml` overlay publishes HA on `:8123` and sets `SUPREME_DEV_MODE=1`
(which surfaces a "Developer" entry + diagnostics in the Supreme UI):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev-mode.yml up -d
# HA reachable at http://localhost:8123 — internal account: admin / admin@supremeos
```

This breaks the invisibility guarantee and must never be used in a customer install.

## Home Assistant image

`infra/hub-compose` runs the official HA **Core** image (not HAOS — Supreme OS is a Docker
Compose appliance). The image defaults to `homeassistant/home-assistant:stable`
(overridable via `SUPREME_HA_IMAGE`); pin a dated tag and gate upgrades through the
HA-regression CI before a production rollout.

## What the installer does NOT do

- Does **not** edit `.env` to supply a HA token.
- Does **not** open, log into, or even know about Home Assistant.
- Sees only Supreme OS branding, login, and the installer portal.
