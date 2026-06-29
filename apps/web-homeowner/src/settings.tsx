import { useEffect, useState } from "react";
import {
  AUREON_ACCENTS,
  AUREON_MODES,
  applyAureonTheme,
  loadAureonTheme,
  saveAureonTheme,
  type AureonAccent,
  type AureonMode,
} from "@supreme/aureon-web";
import { client, fetchLicense, setDevMode, type LicenseInfo } from "./api.js";
import { PasswordInput } from "./password-input.js";

/**
 * Settings (§11.2/§11.3): Appearance (theme + accent), Account (change password), and Integrations
 * (browse + install signed drivers). Applying a theme is a pure repaint; the rest binds to the
 * Supreme API — zero Home Assistant awareness.
 */
export function ThemeSettings() {
  const [choice, setChoice] = useState(loadAureonTheme());

  function update(next: { mode?: AureonMode; accent?: AureonAccent }) {
    const merged = { ...choice, ...next };
    setChoice(merged);
    applyAureonTheme(merged);
    saveAureonTheme(merged);
  }

  return (
    <div className="settings">
      <h1 className="title">Settings</h1>

      <section className="card-section">
        <h2 className="section-title">Appearance</h2>

        <p className="opt-label">Theme</p>
        <div className="seg">
          {AUREON_MODES.map((m) => (
            <button key={m.key} className={choice.mode === m.key ? "on" : ""} onClick={() => update({ mode: m.key })}>
              {m.label}
            </button>
          ))}
        </div>

        <p className="opt-label">Accent</p>
        <div className="seg accents">
          {AUREON_ACCENTS.map((a) => (
            <button key={a.key} className={choice.accent === a.key ? "on" : ""} onClick={() => update({ accent: a.key })}>
              <span className="swatch" style={{ background: a.swatch }} />
              {a.label}
            </button>
          ))}
        </div>
      </section>

      <LicensingSettings />
      <AccountSettings />
      <IntegrationsSettings />
    </div>
  );
}

function LicensingSettings() {
  const [info, setInfo] = useState<LicenseInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setInfo(await fetchLicense());
  }
  useEffect(() => {
    void load();
  }, []);

  async function toggleDev(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      setInfo(await setDevMode(enabled));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change Developer Mode.");
    } finally {
      setBusy(false);
    }
  }

  const svc = info?.service;
  const fmt = (v: string) => v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <section className="card-section">
      <h2 className="section-title">Licensing</h2>
      {svc?.devMode && <div className="dev-banner">⚙ DEVELOPMENT BUILD · Developer License — every feature unlocked</div>}
      <div className="lic-grid">
        <div><span className="k">License</span><span className="v">{svc ? fmt(svc.licenseType) : "—"}</span></div>
        <div><span className="k">Tier</span><span className="v">{svc ? fmt(svc.tier) : "—"}</span></div>
        <div><span className="k">Status</span><span className="v">{svc?.active ? "Active" : "Community (unlicensed)"}</span></div>
        <div><span className="k">Expires</span><span className="v">{svc?.expiresAt ? new Date(svc.expiresAt).toLocaleDateString() : "Never"}</span></div>
        <div><span className="k">Drivers (SKUs)</span><span className="v">{svc?.skus === "all" ? "All" : (svc?.skus.length ? svc.skus.join(", ") : "None")}</span></div>
        <div><span className="k">Features</span><span className="v">{svc?.features === "all" ? "All" : (svc?.features.length ? svc.features.map(fmt).join(", ") : "Core")}</span></div>
      </div>
      <label className="dev-toggle">
        <input type="checkbox" checked={Boolean(svc?.devMode)} disabled={busy} onChange={(e) => toggleDev(e.target.checked)} />
        <span>Developer Mode — unlock every driver &amp; feature (development only)</span>
      </label>
      {error && <p className="err">{error}</p>}
    </section>
  );
}

function AccountSettings() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function change() {
    setMsg(null);
    if (next.length < 8) return setMsg({ ok: false, text: "New password must be at least 8 characters." });
    if (next !== confirm) return setMsg({ ok: false, text: "New passwords don't match." });
    setBusy(true);
    try {
      await client.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setMsg({ ok: true, text: "Password updated." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not change the password." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card-section">
      <h2 className="section-title">Account</h2>
      <p className="opt-label">Change password</p>
      <PasswordInput value={current} onChange={setCurrent} placeholder="Current password" />
      <div style={{ height: 8 }} />
      <PasswordInput value={next} onChange={setNext} placeholder="New password (min 8 characters)" />
      <div style={{ height: 8 }} />
      <PasswordInput value={confirm} onChange={setConfirm} placeholder="Confirm new password" />
      {msg && <p className={msg.ok ? "muted" : "err"}>{msg.text}</p>}
      <button className="primary" disabled={busy || !current || !next} onClick={change} style={{ marginTop: 10 }}>
        {busy ? "Updating…" : "Update password"}
      </button>
    </section>
  );
}

interface CatalogEntry {
  manifest: { key: string; name: string; category?: string };
}

function IntegrationsSettings() {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [installedKeys, setInstalledKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function load() {
    try {
      const cat = (await client.driversCatalog()) as { catalog: CatalogEntry[] };
      const inst = (await client.installedDrivers()) as { drivers: { key: string }[] };
      setCatalog(cat.catalog);
      setInstalledKeys(new Set(inst.drivers.map((d) => d.key)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load integrations.");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function install(key: string) {
    setBusyKey(key);
    setError(null);
    try {
      await client.installDriver(key);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Install failed.");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <section className="card-section">
      <h2 className="section-title">Integrations &amp; drivers</h2>
      <p className="sub">Add a protocol or device integration to your home.</p>
      {error && <p className="err">{error}</p>}
      {catalog.length === 0 && !error && <p className="muted">No integrations available.</p>}
      {catalog.map((entry) => {
        const m = entry.manifest;
        const installed = installedKeys.has(m.key);
        return (
          <div key={m.key} className="row" style={{ justifyContent: "space-between", alignItems: "center", padding: "8px 0" }}>
            <span>
              <strong>{m.name}</strong>
              {m.category ? <span className="muted"> · {m.category}</span> : null}
            </span>
            {installed ? (
              <span className="muted">Installed</span>
            ) : (
              <button className="primary" disabled={busyKey === m.key} onClick={() => install(m.key)}>
                {busyKey === m.key ? "Installing…" : "Install"}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
