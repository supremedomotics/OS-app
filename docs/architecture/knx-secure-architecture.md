# KNX Secure — Architecture (two security layers)

Scope: structure and interaction only. Wire formats, algorithms and parameters are intentionally absent:
they are BLOCKED-SPEC (see `knx-secure-requirements-matrix.md`).

## Two independent layers

| | KNX IP Secure | KNX Data Secure |
|---|---|---|
| Protects | The IP hop between SupremeOS and a KNXnet/IP interface/router (tunnel or routing traffic) | Individual group/application telegrams, end to end across the whole installation |
| Where it lives in the stack | Between UDP/TCP transport and KNXnet/IP framing (a secure session wraps ordinary frames) | Inside the cEMI/APDU: above framing, below DPT decoding |
| Keys come from | Interface credentials in the keyring | Per-group-address and per-device keys in the keyring |
| Failure means | The connection must not be used | The telegram must be dropped; its payload never reaches a DPT codec |

They are orthogonal: an installation may use either, both, or neither, per endpoint and per group address. A Data Secure
telegram is still secured when carried over plain IP; IP Secure does not authenticate who sent a group value. The design
therefore never lets one layer stand in for the other.

## Module layering (dependency direction ↓)

```
driver adapters (KnxConnection / IKnxProvider, feature-flagged)        existing, unchanged
  └ group-state & feedback attribution
      └ DPT codecs (dpt.ts)                  ← only ever fed VERIFIED payloads
          └ Data Secure (planned secure/data-*)   ← classifies APDU: plain | secured-verified | rejected
              └ cEMI (cemi.ts)
                  └ KNXnet/IP session (tunnel-client.ts | planned secure/ip-*)
                      └ framing (knxnetip-frame.ts)
                          └ transport (transport.ts, udp-socket.ts) | simulator
keyring/ (planned)  →  security/keystore.ts → security/secret.ts      (key supply to both layers; no layer reads files)
security/policy.ts  — the fail-closed gate consulted before any socket opens
```

## Interaction rules (design invariants, enforced where code exists)

1. **No downgrade.** A secure-required endpoint either gets a verified secure session or fails with a typed error.
   `policy.ts` + `KnxTunnelClient` enforce this today by refusing construction (S-06).
2. **Verify before decode.** The DPT layer accepts only payloads that left the Data Secure classifier as plain-by-design
   or verified. Today any group APDU that is not a plain group-value service is withheld and counted (S-07).
3. **Secrets flow one way.** Keys live in `KeyStore`; layers receive `Secret` handles scoped to a session, never file paths,
   never strings; nothing logs a `Secret` (S-01).
4. **Counters are never reset to a previously used value.** Reconnect either starts a new session or resumes a persisted
   monotonic counter (details BLOCKED-SPEC; requirement IPS-09).
5. **Standard operation stays independent.** Plain tunnelling does not import secure modules; secure modules depend on
   plain framing, not the reverse.
6. **Local only.** No component calls out; credentials, keyring, diagnostics and runtime stay on the hub.
7. **KNX IoT (CoAP) is a separate transport** (`knx-iot-*`), unrelated to this document.

## Diagnostics & audit
Typed, redacted events for: missing key, authentication failure, replay, sequence error, session failure, keyring
rejection. Events carry identifiers (GA, device, session id), never key bytes. Keystore mutations already emit audit events.
