import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@supreme/aureon-web";
import type { MatterBridgeDeviceEntry, MatterBridgePairing, MatterBridgeStatus } from "@supreme/sdk";
import { client } from "./api.js";

/**
 * Matter Bridge card + devices page (§ Matter Bridge Phase 6). Deliberately NOT one of the
 * registry-driven `.ext-card`s in `extensions.tsx` (the Bridge is not an `INativeProtocolDriver`
 * — § Phase 1's architecture decision: it exposes SupremeOS devices outward, it doesn't own a
 * wire protocol — so it has no Driver Manager manifest entry and never will), but it renders
 * with the SAME `ext-card`/`ext-head` markup and sits INSIDE the extension grid (`extensions.tsx`
 * places it as the grid's first item) so it reads as part of "all drivers", not a separate
 * pinned panel above the list.
 *
 * The QR image is rendered entirely client-side via the `qrcode` package (pure computation,
 * zero network calls) — the pairing payload never leaves the browser to reach a third-party
 * QR-generator service, consistent with the Bridge staying 100% local end to end.
 */
export function MatterBridgePanel({ onOpenDevices }: { onOpenDevices: () => void }) {
  const [status, setStatus] = useState<MatterBridgeStatus | null>(null);
  const [pairing, setPairing] = useState<MatterBridgePairing | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [open, setOpen] = useState(false);

  async function refresh() {
    const s = await client.matterBridgeStatus();
    setStatus(s);
    if (s.running && !s.commissioned) {
      try {
        const p = await client.matterBridgePairing();
        setPairing(p);
        setQrDataUrl(await QRCode.toDataURL(p.qrPairingCode, { margin: 1, width: 220 }));
      } catch {
        setPairing(null);
        setQrDataUrl(null);
      }
    } else {
      setPairing(null);
      setQrDataUrl(null);
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
    <div className={`ext-card${open ? " open" : ""}`}>
      <button className="ext-head" onClick={() => setOpen((v) => !v)}>
        <span className="ext-ic">🔌</span>
        <span className="ext-meta">
          <span className="ext-name-row">
            <span className="ext-name">Matter Bridge</span>
            <span className="cert cert-official"><span className="cert-glyph">✓</span>Official</span>
          </span>
          <span className="ext-sub">Exposes your on/off lights to Apple Home, Google Home, Alexa &amp; SmartThings</span>
        </span>
        <span className={`drv-badge ${status.running ? "ok" : "off"}`}>{status.running ? "RUNNING" : "DISABLED"}</span>
      </button>

      {open && (
        <div style={{ padding: "0 16px 16px" }}>
          {error && <p style={{ color: "var(--aureon-color-status-critical)" }}>{error}</p>}

          <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            {status.running ? (
              <>
                <Button disabled={busy} onClick={() => run(() => client.disableMatterBridge())}>Disable</Button>
                <Button disabled={busy} onClick={() => run(() => client.refreshMatterBridge())}>Refresh devices</Button>
                <Button disabled={busy} onClick={onOpenDevices}>View bridged devices</Button>
              </>
            ) : (
              <Button disabled={busy} variant="primary" onClick={() => run(() => client.enableMatterBridge())}>Enable</Button>
            )}
          </div>
          {status.running && <p className="muted">Refresh picks up any new SupremeOS device — existing ones keep their identity.</p>}

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
                  <div className="row" style={{ gap: 16, alignItems: "flex-start" }}>
                    {qrDataUrl && (
                      <img
                        src={qrDataUrl}
                        alt="Matter pairing QR code — scan with your controller's app"
                        width={220}
                        height={220}
                        style={{ borderRadius: 8, background: "#fff", padding: 8 }}
                      />
                    )}
                    <div>
                      <p>
                        <strong>Manual pairing code:</strong>{" "}
                        <code style={{ fontSize: "1.2em", letterSpacing: "0.05em" }}>{pairing.manualPairingCode}</code>
                      </p>
                      <p className="muted">Scan the QR code, or type the manual code, in Apple Home / Google Home / Alexa / SmartThings.</p>
                      <details>
                        <summary>QR payload (advanced)</summary>
                        <code style={{ wordBreak: "break-all" }}>{pairing.qrPairingCode}</code>
                      </details>
                    </div>
                  </div>
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
      )}
    </div>
  );
}

/**
 * Bridged Devices page (§ Extension Center) — a full page, not an inline panel, reached from
 * the Matter Bridge card's "View bridged devices" (same page-replacement pattern `App.tsx` uses
 * for the canonical device detail: the caller swaps this in for its normal content and gives it
 * an `onBack`, rather than this component owning any navigation state of its own).
 */
export function MatterBridgeDevicesPage({ onBack }: { onBack: () => void }) {
  const [devices, setDevices] = useState<MatterBridgeDeviceEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setDevices(await client.matterBridgeDevices());
  }
  useEffect(() => {
    void load();
  }, []);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      await client.refreshMatterBridge();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "refresh failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <button className="chip" onClick={onBack} style={{ marginBottom: 12 }}>← Back to Extension Center</button>
        <h1 className="title">Bridged Devices</h1>
        <p className="sub">Every SupremeOS device the Matter Bridge currently exposes to Apple Home, Google Home, Alexa &amp; SmartThings, under its real SupremeOS name.</p>
      </div>

      <div className="row" style={{ gap: 8, marginBottom: 16 }}>
        <Button disabled={busy} variant="primary" onClick={refresh}>Refresh devices</Button>
      </div>
      {error && <p style={{ color: "var(--aureon-color-status-critical)" }}>{error}</p>}
      <p className="muted" style={{ marginBottom: 16 }}>Refresh picks up any new SupremeOS device — existing ones keep their identity.</p>

      {devices === null && <p className="muted">Loading…</p>}
      {devices && devices.length === 0 && <p className="muted">No devices are bridged yet. Enable the Bridge or click Refresh once you've added on/off devices.</p>}

      {devices && devices.length > 0 && (
        <div className="ext-grid">
          {devices.map((d) => (
            <div key={d.deviceId} className="ext-card">
              <div className="ext-head" style={{ cursor: "default" }}>
                <span className="ext-ic">💡</span>
                <span className="ext-meta">
                  <span className="ext-name-row">
                    <span className="ext-name">{d.name ?? `(removed from SupremeOS — ${d.deviceId})`}</span>
                  </span>
                  <span className="ext-sub">Matter endpoint {d.endpointNumber}</span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
