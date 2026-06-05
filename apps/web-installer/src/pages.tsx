import { useEffect, useState } from "react";
import type {
  CatalogEntry,
  DiagnosticsReport,
  FleetHub,
  LicenseStatus,
  MigrationStatus,
} from "@supreme/contracts";
import type { InstalledDriver } from "@supreme/domain-model";
import { client } from "./api.js";
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
    { backendId: string; suggestedName: string; capabilities: string[]; source: string }[]
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

  async function commission(d: { backendId: string; suggestedName: string; capabilities: string[] }) {
    await client.commission({
      backendId: d.backendId,
      name: d.suggestedName,
      roomId,
      capabilities: d.capabilities as never,
    });
    await scan();
  }

  return (
    <section>
      <h2>Commissioning</h2>
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
            <div className="muted">{d.capabilities.join(", ")}</div>
          </div>
          <button onClick={() => commission(d)}>Commission</button>
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
