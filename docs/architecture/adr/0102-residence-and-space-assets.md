# 0102 — Residence and Space Assets (imagery)

## Status

**Accepted** for the homeowner Flutter generation (`apps/new`). Records a decision only; no backend
extension is implemented by this ADR (see `docs/architecture/homeowner-contract-gate.md` §7).

## Context

The Golden Master is photographic: Spaces, Space, Home and Experiences are all led by a picture, and
the picture is graded by the room's confirmed light (`tone.js`). Production today:

* **Space imagery already exists as a Hub-served resource.** `Room.heroImageUrl` is a hub-relative path
  (`/v1/rooms/:id/hero-image`); the bytes are stored in the Hub's `homeConfig` (`heroImageKey(roomId)`);
  `GET` serves them with `cache-control: private, max-age=86400`; `PUT` replaces them (owner);
  `POST …/auto` pins a stock photo **downloaded from the internet by room name** at commissioning.
* The `GET` route authenticates with `ctx.identity.authenticate(token)` and takes the token from the
  `Authorization` header or `?access_token=`. It does **not** use `authenticateMobileOrUser`, so a paired
  SupremeOS Mobile's authorization is not accepted (every other route a Mobile uses does accept it).
* There is **no residence-level image** (Home and whole-residence Experiences use one in the prototype)
  and no image metadata (where the windows are, the colour temperature the photo was taken at).
* The Flutter client cannot show a hub-relative image: it has no authenticated byte fetch, so
  `heroImageFor(space)` returns null for relative paths and plates render as tonal plates.

The question: is imagery a **Residence Asset**, a **Space Asset**, or a generic **Hub-served resource**?

## Decision

1. **An asset belongs to the entity it depicts, and is served by the Hub.** There is no separate
   "Residence Assets" service or store. Two slots, one serving contract:
   * **Space Asset** — `Room.heroImageUrl` (exists; keep the storage and the path).
   * **Residence Asset** — `Home.heroImageUrl`, same storage (`homeConfig`, key `home_hero_image`), path
     `/v1/home/hero-image`. Used by Home and whole-residence Experiences.
2. **One serving contract for every asset** (extend the existing route, do not fork it):
   * authenticated by the same bridge as every other Mobile route (`authenticateMobileOrUser`); the
     `?access_token=` fallback stays for `<img>` on the web only;
   * a **strong ETag** (content hash) and `If-None-Match` → `304`; the entity carries the hash
     (`heroImageUrl` is `…/hero-image?v=<hash>`), so a changed photograph is a new URL and an unchanged one
     is cached forever (`immutable`);
   * content types limited to `image/jpeg|png|webp`, size-capped (existing 5 MB rule).
3. **Local-first:** the Hub is the only source a client trusts. A client never loads an image from a
   third-party URL; the only internet fetch in the whole path is the Hub's optional commissioning-time
   stock download, which is stored and thereafter served locally. The client caches by
   `(hubId, url-with-hash)` on the device.
4. **Metadata is separate from bytes and optional:** `assetMeta` (exterior/window masks, the colour
   temperature the photograph was taken at) is a later sibling field on the same entity. Until it exists
   the client grades the picture with the reference white balance and no window mask — it must not
   pretend to know where the windows are.
5. **Absence is a first-class state.** An entity with no asset renders the tonal plate. Nothing is ever
   substituted from a bundled or stock image inside the app.

## Why not the alternatives

* *A Residence Assets service* — one asset kind and two owners does not justify a subsystem; ADR 0021's
  "one owner per fact" is satisfied by keeping the asset with its entity.
* *Space-only assets* — leaves Home and whole-residence Experiences with nothing to lead with; the
  Golden Master needs both.
* *A generic key/value blob store exposed to clients* — invites clients to invent asset kinds; a typed
  slot per entity is enough and testable.

## Consequences

* Client work (Phase 3, after the Hub extension lands): `HubTransport.getBytes` with the paired
  authorization, a device-side cache, and `ToneSurface(image: …)` (already implemented, currently fed
  null for relative paths).
* Hub work (minimum): accept Mobile authorization on the `GET`; ETag + versioned URL; `Home.heroImageUrl`
  + `GET|PUT /v1/home/hero-image`. Nothing else.
* Until then the plates are honest tonal plates and the docs say so; no surface is untruthful.
