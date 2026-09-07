import { useEffect, useState } from "react";
import { Button } from "@supreme/aureon-web";
import type { MatterBridgePairing, MatterBridgeStatus } from "@supreme/sdk";
import { client } from "./api.js";

/**
 * Matter Bridge panel (§ Matter Bridge Phase 6) — deliberately NOT one of the registry-driven
 * `.ext-card`s in `extensions.tsx`: the Bridge is not an `INativeProtocolDriver` (§ Phase 1's
 * architecture decision — it exposes SupremeOS devices outward, it doesn't own a wire
 * protocol), so it has no Driver Manager manifest entry and never will; giving it a fake one
 * just to reuse that card grid would misrepresent it. This is its own small, honestly-labeled
 * panel calling the Bridge's own REST surface directly.
 *
 * No QR image is rendered here — pulling in a QR-rendering dependency (or, worse, sending the
 * pairing payload to a third-party QR-generator service) for one screen wasn't worth it; the
 * manual pairing code below is the spec-standard, fully sufficient way to commission a Matter
 * device by hand. The raw QR payload is shown as copyable text for anyone who wants to feed it
 * into their own tooling.
 */
export function MatterBridgePanel() {
  const [status, setStatus] = useState<MatterBridgeStatus | null>(null);
  const [pairing, setPairing] = useState<MatterBridgePairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);

  async function refresh() {
    const s = await client.matterBridgeStatus();
    setStatus(s);
    if (s.running && !s.commissioned) {
      try {
        setPairing(await client.matterBridgePairing());
      } catch {
        setPairing(null);
      }
    } else {
      setPairing(null);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function run(action: () => Promise<MatterBridgeStatus>) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await action());
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "action failed");
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  return (
    <div className="ext-card open" style={{ marginBottom: 24 }}>
      <div className="ext-head" style={{ cursor: "default" }}>
        <span className="ext-ic">🔌</span>
        <span className="ext-meta">
          <span className="ext-name-row">
            <span className="ext-name">Matter Bridge</span>
            <span className="cert cert-official"><span className="cert-glyph">✓</span>Official</span>
          </span>
          <span className="ext-sub">Exposes your on/off lights to Apple Home, Google Home, Alexa &amp; SmartThings</span>
        </span>
        <span className={`drv-badge ${status.running ? "ok" : "off"}`}>{status.running ? "RUNNING" : "DISABLED"}</span>
      </div>

      <div style={{ padding: "0 16px 16px" }}>
        {error && <p style={{ color: "var(--aureon-color-status-critical)" }}>{error}</p>}

        <div className="row" style={{ gap: 8, marginBottom: 12 }}>
          {status.running ? (
            <Button disabled={busy} onClick={() => run(() => client.disableMatterBridge())}>Disable</Button>
          ) : (
            <Button disabled={busy} variant="primary" onClick={() => run(() => client.enableMatterBridge())}>Enable</Button>
          )}
        </div>

        {status.running && (
          <>
            <p>
              <strong>Commissioned:</strong> {status.commissioned ? "Yes" : "No — ready to pair"}
            </p>

            {status.fabrics.length > 0 && (
              <>
                <strong>Paired ecosystems</strong>
                <ul>
                  {status.fabrics.map((f) => (
                    <li key={f.fabricIndex}>{f.label ?? `Fabric ${f.fabricIndex}`}</li>
                  ))}
                </ul>
              </>
            )}

            {pairing && (
              <div className="card" style={{ marginTop: 8 }}>
                <p className="muted">
                  Sensitive — use this to pair from Apple Home, Google Home, Alexa, or SmartThings. Don't share it.
                </p>
                <p>
                  <strong>Manual pairing code:</strong>{" "}
                  <code style={{ fontSize: "1.2em", letterSpacing: "0.05em" }}>{pairing.manualPairingCode}</code>
                </p>
                <details>
                  <summary>QR payload (advanced)</summary>
                  <code style={{ wordBreak: "break-all" }}>{pairing.qrPairingCode}</code>
                </details>
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              {!confirmingReset ? (
                <Button disabled={busy} onClick={() => setConfirmingReset(true)}>Factory reset Matter identity…</Button>
              ) : (
                <div className="row" style={{ gap: 8 }}>
                  <span className="muted">This removes all Matter pairings and cannot be undone. Are you sure?</span>
                  <Button
                    disabled={busy}
                    variant="danger"
                    onClick={() => {
                      setConfirmingReset(false);
                      void run(() => client.matterBridgeFactoryReset());
                    }}
                  >
                    Yes, factory reset
                  </Button>
                  <Button disabled={busy} onClick={() => setConfirmingReset(false)}>Cancel</Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
