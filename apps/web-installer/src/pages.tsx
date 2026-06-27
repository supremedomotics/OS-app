import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type {
  CatalogEntry,
  DiagnosticsReport,
  FleetHub,
  LicenseStatus,
  MigrationStatus,
} from "@supreme/contracts";
import type { InstalledDriver } from "@supreme/domain-model";
import { client, importKnx, importKnxProject, type KnxImportResult } from "./api.js";
import { fleetConfigured, listFleetHubs } from "./fleet.js";

/** Driver Store: browse the signed catalog, install (license-gated), enable/disable. */
export function DriverStore() {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledDriver[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setCatalog((await client.driversCatalog()).catalog);
    setInstalled((await client.installedDrivers()).drivers);
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function install(key: string) {
    setError(null);
    try {
      await client.installDriver(key);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "install failed");
    }
  }

  const installedKeys = new Set(installed.map((d) => d.key));

  return (
    <section>
      <h2>Driver Store</h2>
      {error && <p style={{ color: "var(--aureon-color-status-critical)" }}>{error}</p>}
      {catalog.map((entry) => {
        const m = entry.manifest;
        const inst = installed.find((d) => d.key === m.key);
        return (
          <div className="card" key={m.key}>
            <div className="row">
              <div>
                <strong>{m.name}</strong> <span className="tag">{m.channel}</span>{" "}
                <span className="tag">{m.version}</span>
                {m.compat.requiresSku && <span className="tag">SKU: {m.compat.requiresSku}</span>}
                <div className="muted">{m.description}</div>
              </div>
              <div>
                {inst ? (
                  <button
                    onClick={async () => {
                      await client.setDriverEnabled(inst.id as never, !inst.enabled);
                      await refresh();
                    }}
                  >
                    {inst.enabled ? "Disable" : "Enable"}
                  </button>
                ) : (
                  <button className="primary" onClick={() => install(m.key)}>
                    Install
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
      <p className="muted">{installedKeys.size} installed</p>
    </section>
  );
}

/** Commissioning: discover candidate devices and commission them into a room. */
export function Commissioning() {
  const [discovered, setDiscovered] = useState<
    { backendId: string; suggestedName: string; capabilities: string[]; source: string; protocol?: string }[]
  >([]);
  const [rooms, setRooms] = useState<{ id: string; name: string }[]>([]);
  const [roomId, setRoomId] = useState<string>("");

  useEffect(() => {
    void client.home().then((h) => {
      setRooms(h.rooms);
      if (h.rooms[0]) setRoomId(h.rooms[0].id);
    });
  }, []);

  async function scan() {
    setDiscovered((await client.discover()).discovered);
  }

  async function commission(d: {
    backendId: string;
    suggestedName: string;
    capabilities: string[];
    protocol?: string;
  }) {
    await client.commission({
      backendId: d.backendId,
      name: d.suggestedName,
      roomId,
      capabilities: d.capabilities as never,
      // A device discovered on a native bus is bound to it automatically on commission.
      protocol: d.protocol,
    });
    await scan();
  }

  const [knx, setKnx] = useState("");
  const [knxResult, setKnxResult] = useState<string | null>(null);
  function report(out: KnxImportResult) {
    setKnxResult(`Imported ${out.devices} device(s); ${out.roomsCreated} new room(s).`);
    setKnx("");
    void client.home().then((h) => setRooms(h.rooms));
  }
  async function doImportKnx() {
    setKnxResult("Importing…");
    try { report(await importKnx(knx)); } catch (e) { setKnxResult(e instanceof Error ? e.message : "Import failed"); }
  }
  async function onKnxFile(file: File) {
    setKnxResult("Importing…");
    try {
      if (file.name.toLowerCase().endsWith(".knxproj")) {
        const buf = new Uint8Array(await file.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!);
        report(await importKnxProject(btoa(bin)));
      } else {
        setKnx(await file.text());
        setKnxResult(null);
      }
    } catch (e) {
      setKnxResult(e instanceof Error ? e.message : "Import failed");
    }
  }

  return (
    <section>
      <h2>Commissioning</h2>

      {/* KNX has no live discovery — import the ETS group-address export to auto-create cards. */}
      <div className="card">
        <strong>Import KNX project</strong>
        <p className="muted">Upload a <code>.knxproj</code> (device cards placed in their ETS rooms), or paste an ETS group-address export (CSV/XML). Capabilities are inferred from each datapoint type.</p>
        <textarea
          value={knx}
          onChange={(e) => setKnx(e.target.value)}
          placeholder='e.g. <GroupAddress Name="Living Room - Ceiling - Switch" Address="1/1/1" DPTs="DPST-1-1" />'
          rows={5}
          style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <input
            type="file"
            accept=".knxproj,.csv,.xml,text/plain"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onKnxFile(f); }}
          />
          <button className="primary" disabled={!knx.trim()} onClick={doImportKnx}>Import pasted text</button>
        </div>
        {knxResult && <p className="muted">{knxResult}</p>}
      </div>

      <div className="card row">
        <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button className="primary" onClick={scan}>Discover devices</button>
      </div>
      {discovered.map((d) => (
        <div className="card row" key={d.backendId}>
          <div>
            <strong>{d.suggestedName}</strong> <span className="tag">{d.source}</span>
            <div className="muted">
              {d.capabilities.join(", ")}
              {d.protocol && ` · auto-binds to ${d.protocol.toUpperCase()}`}
            </div>
          </div>
          <button onClick={() => commission(d)}>
            {d.protocol ? "Commission + bind" : "Commission"}
          </button>
        </div>
      ))}
    </section>
  );
}

/** Diagnostics: hub + backend health, counts, drivers, offline devices. */
export function Diagnostics() {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  useEffect(() => {
    void client.diagnostics().then(setReport);
  }, []);
  if (!report) return <p>Loading…</p>;
  return (
    <section>
      <h2>Diagnostics</h2>
      <div className="card">
        <div className="row">
          <span>Hub version</span>
          <span>{report.hubVersion}</span>
        </div>
        <div className="row">
          <span>Backend</span>
          <span>
            {report.backend.kind}{" "}
            <span
              className="tag"
              style={{
                color: report.backend.healthy
                  ? "var(--aureon-color-status-good)"
                  : "var(--aureon-color-status-critical)",
              }}
            >
              {report.backend.healthy ? "healthy" : "down"}
            </span>
          </span>
        </div>
      </div>
      <div className="card">
        {Object.entries(report.counts).map(([k, v]) => (
          <div className="row" key={k}>
            <span className="muted">{k}</span>
            <span>{v}</span>
          </div>
        ))}
      </div>
      {report.offlineDevices.length > 0 && (
        <div className="card">
          <strong>Offline devices</strong>
          {report.offlineDevices.map((d) => (
            <div key={d.id} className="muted">{d.name}</div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Backup / Restore + Project Export. */
export function BackupRestore() {
  const [status, setStatus] = useState<string>("");

  async function backup() {
    try {
      const res = await client.backup();
      const blob = new Blob([res.document], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `supreme-backup-${res.meta.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus(`Backed up ${res.meta.rowCount} rows`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "backup failed");
    }
  }

  async function exportProject() {
    const proj = await client.projectExport();
    setStatus(`Exported project: ${proj.devices.length} devices, ${proj.scenes.length} scenes`);
  }

  return (
    <section>
      <h2>Backup &amp; Restore</h2>
      <div className="card row">
        <span>Download a signed backup of the hub system of record.</span>
        <button className="primary" onClick={backup}>Create backup</button>
      </div>
      <div className="card row">
        <span>Export the project document (rooms, devices, scenes, drivers).</span>
        <button onClick={exportProject}>Export project</button>
      </div>
      {status && <p className="muted">{status}</p>}
    </section>
  );
}

/** Native migration: move backend domains from Home Assistant to the Supreme engine. */
export function Migration() {
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setStatus(await client.migrationStatus());
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function migrate(domain: string, engine: "ha" | "native") {
    setBusy(domain);
    setError(null);
    try {
      await client.migrateDomain(domain, engine);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "migration failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2>Native migration</h2>
      <p className="muted">
        Move each backend domain from Home Assistant to the Supreme-native engine. The
        homeowner experience is unaffected — control continues over the same API.
      </p>
      {error && <p style={{ color: "var(--aureon-color-status-critical)" }}>{error}</p>}
      {!status?.enabled && (
        <div className="card">
          <p className="muted">Migration isn't available on this hub (no routing backend).</p>
        </div>
      )}
      {status?.enabled && status.domains.length === 0 && (
        <p className="muted">No backend domains mapped yet.</p>
      )}
      {status?.enabled &&
        status.domains.map((d) => (
          <div className="card row" key={d.domain}>
            <div>
              <strong>{d.domain}</strong>{" "}
              <span
                className="tag"
                style={{
                  color: d.engine === "native" ? "var(--aureon-color-status-good)" : undefined,
                }}
              >
                {d.engine === "native" ? "Supreme-native" : "Home Assistant"}
              </span>
            </div>
            {d.engine === "ha" ? (
              <button className="primary" disabled={busy === d.domain} onClick={() => migrate(d.domain, "native")}>
                {busy === d.domain ? "Migrating…" : "Migrate to native"}
              </button>
            ) : (
              <button disabled={busy === d.domain} onClick={() => migrate(d.domain, "ha")}>
                Revert to HA
              </button>
            )}
          </div>
        ))}
      {status?.fullyMigrated && (
        <div className="card">
          <strong style={{ color: "var(--aureon-color-status-good)" }}>
            Fully migrated — Home Assistant can be retired.
          </strong>
        </div>
      )}
    </section>
  );
}

/** Fleet: oversee an installer org's hubs (optional cloud service). */
export function Fleet() {
  const [hubs, setHubs] = useState<FleetHub[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!fleetConfigured) return;
    void listFleetHubs()
      .then((r) => setHubs(r.hubs))
      .catch((e) => setError(e instanceof Error ? e.message : "failed"));
  }, []);

  if (!fleetConfigured) {
    return (
      <section>
        <h2>Fleet</h2>
        <div className="card">
          <p className="muted">
            Cloud fleet management is optional and not configured. Set
            <code> VITE_SUPREME_FLEET_URL</code> and <code>VITE_SUPREME_FLEET_KEY</code> to
            oversee your org's hubs here. The hub works fully without it.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2>Fleet</h2>
      {error && <p style={{ color: "var(--aureon-color-status-critical)" }}>{error}</p>}
      {hubs.length === 0 && !error && <p className="muted">No hubs registered.</p>}
      {hubs.map((h) => (
        <div className="card row" key={h.id}>
          <div>
            <strong>{h.name}</strong> <span className="tag">{h.version}</span>
            <div className="muted">home {h.homeId} · last seen {new Date(h.lastSeenAt).toLocaleString()}</div>
          </div>
          <span
            className="tag"
            style={{
              color: h.status === "online" ? "var(--aureon-color-status-good)" : "var(--aureon-color-status-critical)",
            }}
          >
            {h.status}
          </span>
        </div>
      ))}
    </section>
  );
}

/** Licensing: show status and activate a license token. */
export function Licensing() {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  useEffect(() => {
    void client.licenseStatus().then(setStatus);
  }, []);
  return (
    <section>
      <h2>Licensing</h2>
      <div className="card">
        <div className="row">
          <span>Status</span>
          <span className="tag">{status?.licensed ? "Licensed" : "Unlicensed"}</span>
        </div>
        <div className="row">
          <span className="muted">Entitled SKUs</span>
          <span>{status?.skus.join(", ") || "—"}</span>
        </div>
        <div className="row">
          <span className="muted">Features</span>
          <span>{status?.features.join(", ") || "—"}</span>
        </div>
      </div>
    </section>
  );
}

/**
 * Bus Binding (§3): wire a commissioned device's capability to a real field-bus
 * address (KNX group address / Modbus register / MQTT base topic). After binding,
 * the device is driven over that bus by the Supreme-native engine. Bindings persist
 * and are re-bound on hub restart.
 */
const PROTOCOLS = ["knx", "modbus", "mqtt"] as const;
const CONFIG_HINTS: Record<string, string> = {
  knx: '{"statusAddress":"1/2/1","dpt":"DPT5.001"}',
  modbus: '{"type":"holding","scale":0.1,"unit":"kWh","measure":"energy"}',
  mqtt: '{"field":"temperature","unit":"°C","measure":"temperature"}',
};

type BindDevice = { id: string; name: string; capabilities: string[] };
type Binding = { deviceId: string; capability: string; protocol: string; address: string };

export function Bindings() {
  const [devices, setDevices] = useState<BindDevice[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [capability, setCapability] = useState("");
  const [protocol, setProtocol] = useState<(typeof PROTOCOLS)[number]>("knx");
  const [address, setAddress] = useState("");
  const [configText, setConfigText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const home = await client.home();
    const lists = await Promise.all(home.rooms.map((r) => client.devicesInRoom(r.id as never)));
    const all = lists.flatMap((l) =>
      l.devices.map((d) => ({
        id: d.id,
        name: d.name,
        capabilities: d.capabilities.map((c) => c.kind),
      })),
    );
    setDevices(all);
    setBindings((await client.protocolBindings()).bindings as Binding[]);
  }
  useEffect(() => {
    void refresh();
  }, []);

  const selected = devices.find((d) => d.id === deviceId);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      let config: Record<string, unknown> | undefined;
      if (configText.trim()) config = JSON.parse(configText) as Record<string, unknown>;
      await client.bindProtocol({ deviceId, capability: capability as never, protocol, address, config });
      setAddress("");
      setConfigText("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "binding failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Bus binding</h2>
      <p className="muted">
        Bind a commissioned device to a real field bus (KNX / Modbus / MQTT). The device
        is then driven natively over that bus — no Home Assistant involved.
      </p>
      {error && <p style={{ color: "var(--aureon-color-status-critical)" }}>{error}</p>}

      <div className="card">
        <div className="row">
          <select value={deviceId} onChange={(e) => { setDeviceId(e.target.value); setCapability(""); }}>
            <option value="">Select device…</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <select value={capability} onChange={(e) => setCapability(e.target.value)} disabled={!selected}>
            <option value="">Capability…</option>
            {selected?.capabilities.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <select value={protocol} onChange={(e) => setProtocol(e.target.value as (typeof PROTOCOLS)[number])}>
            {PROTOCOLS.map((p) => (
              <option key={p} value={p}>{p.toUpperCase()}</option>
            ))}
          </select>
        </div>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={protocol === "knx" ? "Group address e.g. 1/2/0" : protocol === "modbus" ? "Register e.g. 100" : "Base topic e.g. z2m/lamp"}
          style={{ marginTop: 8 }}
        />
        <input
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          placeholder={`Config JSON (optional) — e.g. ${CONFIG_HINTS[protocol]}`}
          style={{ marginTop: 8 }}
        />
        <button
          className="primary"
          style={{ marginTop: 8 }}
          disabled={busy || !deviceId || !capability || !address}
          onClick={submit}
        >
          {busy ? "Binding…" : "Bind to bus"}
        </button>
      </div>

      <h3 style={{ marginTop: 16 }}>Active bindings</h3>
      {bindings.length === 0 && <p className="muted">No devices are bound to a bus yet.</p>}
      {bindings.map((b) => {
        const name = devices.find((d) => d.id === b.deviceId)?.name ?? b.deviceId;
        return (
          <div className="card row" key={`${b.deviceId}:${b.capability}`}>
            <div>
              <strong>{name}</strong> <span className="tag">{b.capability}</span>
              <div className="muted">{b.protocol.toUpperCase()} · {b.address}</div>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/**
 * Cameras (§11.1): register view-only cameras with their RTSP/snapshot sources, then
 * play live video. RTSP isn't browser-playable, so the hub transcodes it; the portal
 * plays the resolved HLS stream via hls.js (native HLS on Safari).
 */
type Camera = { id: string; name: string; roomId: string | null; snapshotUrl: string | null; streamUrl: string | null };

function HlsPlayer({ url }: { url: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    // Safari plays HLS natively; elsewhere attach hls.js.
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      return;
    }
    if (!Hls.isSupported()) {
      video.src = url; // last resort
      return;
    }
    const hls = new Hls({ lowLatencyMode: true });
    hls.loadSource(url);
    hls.attachMedia(video);
    return () => hls.destroy();
  }, [url]);
  return <video ref={ref} controls autoPlay muted playsInline style={{ width: "100%", borderRadius: 8, background: "#000" }} />;
}

/**
 * Low-latency WebRTC player via WHEP (WebRTC-HTTP Egress Protocol): create a
 * recvonly peer connection, POST the SDP offer to the stream engine's WebRTC
 * endpoint, apply the answer. Sub-second latency — ideal for door cameras. Calls
 * onError so the caller can fall back to HLS.
 */
function WebRtcPlayer({ url, onError }: { url: string; onError: () => void }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    let cancelled = false;
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.ontrack = (e) => {
      if (e.streams[0]) video.srcObject = e.streams[0];
    };
    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        // Non-trickle WHEP: wait for ICE gathering, then exchange SDP once.
        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === "complete") return resolve();
          const check = () => {
            if (pc.iceGatheringState === "complete") {
              pc.removeEventListener("icegatheringstatechange", check);
              resolve();
            }
          };
          pc.addEventListener("icegatheringstatechange", check);
          setTimeout(resolve, 2000); // fall through if gathering stalls
        });
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/sdp" },
          body: pc.localDescription?.sdp ?? "",
        });
        if (!res.ok) throw new Error(`WHEP ${res.status}`);
        const answer = await res.text();
        if (cancelled) return;
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
      } catch {
        if (!cancelled) onError();
      }
    })();
    return () => {
      cancelled = true;
      pc.close();
    };
  }, [url, onError]);
  return <video ref={ref} autoPlay muted playsInline controls style={{ width: "100%", borderRadius: 8, background: "#000" }} />;
}

export function Cameras() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [active, setActive] = useState<
    { id: string; webrtc: string | null; hls: string | null; mode: "webrtc" | "hls" } | null
  >(null);
  const [name, setName] = useState("");
  const [streamUrl, setStreamUrl] = useState("");
  const [snapshotUrl, setSnapshotUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setCameras((await client.cameras()).cameras as Camera[]);
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function register() {
    setError(null);
    try {
      await client.registerCamera({
        name,
        streamUrl: streamUrl || undefined,
        snapshotUrl: snapshotUrl || undefined,
      });
      setName("");
      setStreamUrl("");
      setSnapshotUrl("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "registration failed");
    }
  }

  async function play(cam: Camera) {
    setError(null);
    try {
      const { streams } = await client.cameraStream(cam.id);
      const webrtc = streams.find((s) => s.kind === "webrtc")?.url ?? null;
      const hls = streams.find((s) => s.kind === "hls")?.url ?? null;
      // Prefer low-latency WebRTC; fall back to HLS automatically on failure.
      setActive({ id: cam.id, webrtc, hls, mode: webrtc ? "webrtc" : "hls" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "no stream available");
    }
  }

  return (
    <section>
      <h2>Cameras</h2>
      <p className="muted">
        Register a camera with its RTSP source; the hub republishes it as browser-playable
        HLS/WebRTC. RTSP is never sent to the browser directly.
      </p>
      {error && <p style={{ color: "var(--aureon-color-status-critical)" }}>{error}</p>}

      <div className="card">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Camera name (e.g. Front Door)" />
        <input
          value={streamUrl}
          onChange={(e) => setStreamUrl(e.target.value)}
          placeholder="RTSP source e.g. rtsp://10.0.0.5:554/h264"
          style={{ marginTop: 8 }}
        />
        <input
          value={snapshotUrl}
          onChange={(e) => setSnapshotUrl(e.target.value)}
          placeholder="Snapshot URL (optional) e.g. http://10.0.0.5/snap.jpg"
          style={{ marginTop: 8 }}
        />
        <button className="primary" style={{ marginTop: 8 }} disabled={!name} onClick={register}>
          Register camera
        </button>
      </div>

      {active && (active.webrtc || active.hls) && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="row">
            <strong>{cameras.find((c) => c.id === active.id)?.name ?? "Live"}</strong>
            <span>
              <span
                className="tag"
                style={{ color: active.mode === "webrtc" ? "var(--aureon-color-status-good)" : undefined }}
              >
                {active.mode === "webrtc" ? "WebRTC · low latency" : "HLS · compatible"}
              </span>
              {active.webrtc && active.hls && (
                <button
                  style={{ marginLeft: 8 }}
                  onClick={() =>
                    setActive((a) => (a ? { ...a, mode: a.mode === "webrtc" ? "hls" : "webrtc" } : a))
                  }
                >
                  {active.mode === "webrtc" ? "Use HLS" : "Use WebRTC"}
                </button>
              )}
            </span>
          </div>
          <div style={{ marginTop: 8 }}>
            {active.mode === "webrtc" && active.webrtc ? (
              <WebRtcPlayer
                url={active.webrtc}
                onError={() => setActive((a) => (a ? { ...a, mode: "hls" } : a))}
              />
            ) : active.hls ? (
              <HlsPlayer url={active.hls} />
            ) : (
              <p className="muted">No playable stream.</p>
            )}
          </div>
        </div>
      )}

      {cameras.length === 0 && <p className="muted">No cameras registered yet.</p>}
      {cameras.map((c) => (
        <div className="card row" key={c.id}>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {c.snapshotUrl ? (
              <img
                src={c.snapshotUrl}
                alt={c.name}
                style={{ width: 96, height: 54, objectFit: "cover", borderRadius: 6, background: "#000" }}
              />
            ) : (
              <div style={{ width: 96, height: 54, borderRadius: 6, background: "#000" }} />
            )}
            <div>
              <strong>{c.name}</strong>
              <div className="muted">{c.streamUrl ?? "no source configured"}</div>
            </div>
          </div>
          <button onClick={() => play(c)} disabled={!c.streamUrl}>
            Live view
          </button>
        </div>
      ))}
    </section>
  );
}
