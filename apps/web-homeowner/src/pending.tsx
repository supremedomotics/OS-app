import { useEffect, useState } from "react";
import { Grid } from "@supreme/aureon-web";
import { client } from "./api.js";

/**
 * Device Approval (§ Device Approval) — the queue of devices that have been discovered but not yet
 * trusted into the home. An installer reviews each, then Approves it into a room (commissioning it,
 * carrying over its captured IP/MAC) or Rejects it. Reuses the commissioning service for approval —
 * no separate device path. Rendered at the top of the Devices page; hidden when the queue is empty.
 */
type Pending = { id: string; suggestedName: string; protocol: string | null; source: string; capabilities: string[]; network: { ip?: string; mac?: string } | null; lastSeen: string; roomHint?: string | null; driverName?: string | null };
type Room = { id: string; name: string };

/** Matches the gateway's `normalizeRoomName` (§ Universal Room Intelligence) so "R&D"/"r&d"/
 * "R & D" compare equal here too — same rule the backend's resolveOrCreateRoom uses. */
function normalizeRoomName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

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

  // `roomId === ""` means "Auto" — omit roomId entirely so the backend's shared
  // resolveOrCreateRoom() resolves/creates the room from the device's own roomHint
  // (§ Universal Room Intelligence), exactly like the direct-commission path. An explicit
  // room choice always overrides it (§ Room Resolution Priority — installer wins).
  async function approve(p: Pending, roomId: string) {
    if (!roomId && !p.roomHint && rooms.length === 0) { setErr("Pick a room to approve into."); return; }
    setBusy(p.id); setErr(null);
    try { await client.approvePendingDevice(p.id, roomId ? { roomId } : {}); await load(); onChanged(); }
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
      <Grid minItemWidth={280}>
        {pending.map((p) => (
          <PendingCard key={p.id} device={p} rooms={rooms} busy={busy === p.id} onApprove={(r) => approve(p, r)} onReject={() => reject(p)} />
        ))}
      </Grid>
      {err && <p className="err">{err}</p>}
    </div>
  );
}

function PendingCard({ device, rooms, busy, onApprove, onReject }: {
  device: Pending; rooms: Room[]; busy: boolean; onApprove: (roomId: string) => void; onReject: () => void;
}) {
  // The device's own reported room (a Casambi Group, an ETS Function/Space, …) — matched
  // against existing SupremeOS rooms the SAME normalized way resolveOrCreateRoom does, purely
  // to show the installer what "Auto" will do. When the driver reports NO hint at all (a real
  // gap seen on hardware — Casambi luminaires with no Group assigned still report nothing),
  // fall back to matching the device's own name against an existing room, same as the direct
  // Discovery pairing flow — never silently defaulting to rooms[0] (§ Universal Room
  // Intelligence): forcing an explicit roomId every time defeated both the driver's roomHint
  // AND this name fallback, dumping every device into whichever room happened to be first.
  const hintMatch = device.roomHint ? rooms.find((r) => normalizeRoomName(r.name) === normalizeRoomName(device.roomHint!)) : undefined;
  const nameMatch = !device.roomHint
    ? rooms
        .filter((r) => r.name.trim().length > 0 && device.suggestedName.toLowerCase().includes(r.name.trim().toLowerCase()))
        .sort((a, b) => b.name.length - a.name.length)[0]
    : undefined;
  const matchedRoom = hintMatch ?? nameMatch;
  const canAuto = Boolean(device.roomHint || nameMatch);
  const [roomId, setRoomId] = useState(canAuto ? "" : (rooms[0]?.id ?? ""));
  return (
    <div className="ext-card pending-card">
      <div className="ext-head" style={{ cursor: "default" }}>
        <span className="ext-ic">🛡️</span>
        <span className="ext-meta">
          <span className="ext-name">{device.suggestedName}</span>
          {/* Homeowner-facing "new device" card: describe what it does, not how it connects. */}
          <span className="ext-sub">
            {device.capabilities.length > 0 ? device.capabilities.join(", ") : "New device"}
          </span>
        </span>
        <span className="drv-badge off">Pending</span>
      </div>
      <div className="drv-detail">
        <label className="drv-field"><span className="lbl">Approve into room</span>
          <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            {canAuto && (
              <option value="">Auto — {matchedRoom ? matchedRoom.name : `create "${device.roomHint}"`}</option>
            )}
            {rooms.length === 0 && !device.roomHint && <option value="">Create a room first</option>}
            {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          {canAuto && !roomId && (
            <span className="help">
              {matchedRoom ? `Matched from ${hintMatch ? (device.driverName ?? "the driver") + "'s reported room" : "the device's name"}.` : `A new room named "${device.roomHint}" will be created automatically.`}
            </span>
          )}
        </label>
        <div className="drv-actions">
          <button className="primary" disabled={busy || (rooms.length === 0 && !device.roomHint)} onClick={() => onApprove(roomId)}>{busy ? "…" : "Approve"}</button>
          <button className="danger" disabled={busy} onClick={onReject}>Reject</button>
        </div>
      </div>
    </div>
  );
}
