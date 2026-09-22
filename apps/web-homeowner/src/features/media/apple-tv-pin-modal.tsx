import { useState } from "react";
import { Button } from "@supreme/aureon-web";
import { client } from "../../api.js";

/**
 * (§ Apple TV HAP pairing gap fix) — the on-screen 4-digit PIN prompt for an Apple TV
 * that needs HAP pairing, shared by two entry points: Discover Devices, right after an
 * Apple TV is first commissioned (`discover.tsx`'s `FoundDevice`), and an already-
 * commissioned Apple TV whose stored credentials went stale (`device-detail-sections.tsx`'s
 * Diagnostics section surfaces `AppleTvPairingRequiredError`'s message via `lastError`).
 * One component, one flow, reused rather than forked per entry point.
 */
export function AppleTvPinModal({
  deviceId,
  deviceName,
  onPaired,
  onClose,
}: {
  deviceId: string;
  deviceName: string;
  onPaired: () => void;
  onClose: () => void;
}) {
  const [pin, setPin] = useState("");
  const [status, setStatus] = useState<"starting" | "awaiting_pin" | "submitting" | "wrong_pin" | "expired" | "error">("starting");
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  async function start() {
    setStatus("starting");
    setError(null);
    try {
      await client.startAppleTvPairing(deviceId as never);
      setStatus("awaiting_pin");
      setPin("");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Couldn't start pairing.");
    }
  }
  if (!started) {
    setStarted(true);
    void start();
  }

  async function submit() {
    if (pin.length !== 4) return;
    setStatus("submitting");
    setError(null);
    try {
      const res = await client.submitAppleTvPairingPin(deviceId as never, pin);
      if (res.status === "paired") {
        onPaired();
      } else {
        setStatus(res.status);
        setPin("");
      }
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Couldn't submit the PIN.");
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Pair ${deviceName}`}>
      <div className="modal">
        <h3>Pair {deviceName}</h3>
        {status === "starting" && <p className="muted">Connecting to the Apple TV…</p>}
        {(status === "awaiting_pin" || status === "submitting" || status === "wrong_pin") && (
          <>
            <p className="muted">Enter the 4-digit code shown on the Apple TV's screen.</p>
            {status === "wrong_pin" && <p className="err">That code didn't match — try again.</p>}
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="0000"
              inputMode="numeric"
              maxLength={4}
              autoFocus
              style={{ fontSize: "var(--aureon-text-title)", letterSpacing: "0.4em", textAlign: "center" }}
            />
            <div className="drv-actions">
              <Button variant="primary" disabled={pin.length !== 4 || status === "submitting"} onClick={submit} aria-busy={status === "submitting"}>
                {status === "submitting" ? "Verifying…" : "Submit"}
              </Button>
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
            </div>
          </>
        )}
        {status === "expired" && (
          <>
            <p className="err">Pairing timed out. Start again and enter the new code right away.</p>
            <div className="drv-actions">
              <Button variant="primary" onClick={() => void start()}>Start again</Button>
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
            </div>
          </>
        )}
        {status === "error" && (
          <>
            <p className="err">{error ?? "Pairing failed."}</p>
            <div className="drv-actions">
              <Button variant="primary" onClick={() => void start()}>Try again</Button>
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
