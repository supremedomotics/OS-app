import { useEffect, useState } from "react";
import { client } from "./api.js";

/**
 * Device Approval (§ Device Approval) — the queue of devices that have been discovered but not yet
 * trusted into the home. An installer reviews each, then Approves it into a room (commissioning it,
 * carrying over its captured IP/MAC) or Rejects it. Reuses the commissioning service for approval —
 * no separate device path. Rendered at the top of the Devices page; hidden when the queue is empty.
 */
type Pending = { id: string; suggestedName: string; protocol: string | null; source: string; capabilities: string[]; network: { ip?: string; mac?: string } | null; lastSeen: string };
type Room = { id: string; name: string };

export function PendingApproval({ rooms, onChanged }: { rooms: Room[]; onChanged: () => void }) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try { setPending((await client.pendingDevices()).pending as Pending[]); } catch { /* keep prior */ }
  }
  useEffect(() => { void load(); }, []);

  async function scan() {
    setScanning(true); setErr(null);
    try { setPending((await client.scanForApproval()).pending as Pending[]); }
    catch (e) { setErr(e instanceof Error ? e.message : "Scan failed."); }
    finally { setScanning(false); }
  }

  async function approve(p: Pending, roomId: string) {
    if (!roomId) { setErr("Pick a room to approve into."); return; }
    setBusy(p.id); setErr(null);
    try { await client.approvePendingDevice(p.id, { roomId }); await load(); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : "Approval failed."); }
    finally { setBusy(null); }
  }
  async function reject(p: Pending) {
    setBusy(p.id);
    try { await client.rejectPendingDevice(p.id); await load(); }
    finally { setBusy(null); }
  }

  // Only render the section when there's something pending or after an explicit scan.
  if (pending.length === 0) {
    return (
      <div className="pending-head">
        <button disabled={scanning} onClick={scan}>{scanning ? "Scanning…" : "Scan for new devices"}</button>
        {err && <span className="err" style={{ marginLeft: 8 }}>{err}</span>}
      </div>
    );
  }

  return (
    <div className="pending">
      <div className="pending-head">
        <h2 className="section" style={{ margin: 0 }}>Pending approval <span className="chip-n">{pending.length}</span></h2>
        <button disabled={scanning} onClick={scan}>{scanning ? "Scanning…" : "Rescan"}</button>
      </div>
      <p className="muted">Review devices found on your network. Approve the ones you recognise; reject the rest.</p>
      <div className="grid">
        {pending.map((p) => (
          <PendingCard key={p.id} device={p} rooms={rooms} busy={busy === p.id} onApprove={(r) => approve(p, r)} onReject={() => reject(p)} />
        ))}
      </div>
      {err && <p className="err">{err}</p>}
    </div>
  );
}

function PendingCard({ device, rooms, busy, onApprove, onReject }: {
  device: Pending; rooms: Room[]; busy: boolean; onApprove: (roomId: string) => void; onReject: () => void;
}) {
  const [roomId, setRoomId] = useState(rooms[0]?.id ?? "");
  return (
    <div className="ext-card pending-card">
      <div className="ext-head" style={{ cursor: "default" }}>
        <span className="ext-ic">🛡️</span>
        <span className="ext-meta">
          <span className="ext-name">{device.suggestedName}</span>
          <span className="ext-sub">
            {device.protocol ? device.protocol.toUpperCase() : device.source} · {device.capabilities.join(", ")}
            {device.network?.ip ? ` · ${device.network.ip}` : ""}{device.network?.mac ? ` · ${device.network.mac}` : ""}
          </span>
        </span>
        <span className="drv-badge off">Pending</span>
      </div>
      <div className="drv-detail">
        <label className="drv-field"><span className="lbl">Approve into room</span>
          <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            {rooms.length === 0 && <option value="">Create a room first</option>}
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <div className="drv-actions">
          <button className="primary" disabled={busy || rooms.length === 0} onClick={() => onApprove(roomId)}>{busy ? "…" : "Approve"}</button>
          <button className="danger" disabled={busy} onClick={onReject}>Reject</button>
        </div>
      </div>
    </div>
  );
}
