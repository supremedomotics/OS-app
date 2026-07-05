# ADR 0006 — Native migration (strangler-fig) and the on-box LLM

- Status: **Accepted**
- Date: 2026-06-05
- Context: Phase 4 (Native migration, §16) + a real on-box AI model (§10).

## Decision 1 — Per-domain HA→native migration behind a routing adapter

The SIL is backed by a `RoutingBackendAdapter` that implements the same
`IBackendAdapter` contract while delegating each **backend domain** (light, climate,
cover, …) to either the `HaAdapter` or the `SupremeNativeAdapter`, chosen by a
`MigrationPolicy`. Migrating a domain to native:

1. seeds the native engine's state from the current HA state for the domain's
   devices, then
2. flips the routing flag.

After the flip, the *same* `command()`/`getState()` calls route to the native
engine. The SIL facade, domain services, gateway, SDKs, and clients are entirely
unaware — this is the migration guarantee (ADR 0001) realized. When every domain is
native, the HA adapter is dead weight and can be removed. Operators drive this with
`GET /v1/migration` + `POST /v1/migration/:domain` (admin, audited); the change is
verified by a gateway e2e that controls a device via HA, migrates its domain, and
keeps controlling it over the identical API.

## Decision 2 — A real, optional on-box LLM with a deterministic safety net

The AI assistant runs a genuine local model via **llama-cpp-python** (no cloud, no
keys) when a GGUF is provisioned (`SUPREME_AI_MODEL_PATH`), with JSON-constrained
decoding. Because small on-box models are unreliable, the model's draft is accepted
only when it is **structurally valid, referentially valid (every device id exists),
and plausible (referenced devices are named in the request)**; otherwise the
service falls back to the deterministic planner. So the assistant is always correct
and always available — the LLM augments it, never gates it.

Weights are **never committed** to the repo or baked into images; they are
provisioned to the appliance (`fetch-ai-model.sh`, or an OCI model artifact). The
runtime is an opt-in image build (`WITH_LLM=1`).

## Consequences

- Migration is incremental and reversible (flip a domain back to HA), de-risking the
  strangler-fig rollout.
- The LLM's quality scales with the provisioned model; the deterministic planner
  guarantees a correct floor regardless, which is what makes shipping a tiny model
  safe.
