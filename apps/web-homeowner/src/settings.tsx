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
import { activateLicense, client, devIssueLicense, fetchLicense, setDevMode, type LicenseInfo } from "./api.js";
import { PasswordInput } from "./password-input.js";
import { DriverManager } from "./drivers.js";
import { DeveloperTools } from "./developer.js";

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
      <DriverManager />
      <DeveloperTools />
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
      <ActivateLicense onActivated={load} devMode={Boolean(svc?.devMode)} />
    </section>
  );
}

/** Activate a signed license (paste a token / import a .slic file); dev builds can issue a test one. */
function ActivateLicense({ onActivated, devMode }: { onActivated: () => Promise<void>; devMode: boolean }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function activate(raw?: string) {
    const text = (raw ?? token).trim();
    if (!text) return;
    setBusy(true);
    setMsg(null);
    try {
      await activateLicense(JSON.parse(text));
      setToken("");
      setMsg({ ok: true, text: "License activated." });
      await onActivated();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Activation failed." });
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    const text = await file.text();
    setToken(text);
    await activate(text);
  }

  async function issueTest() {
    setBusy(true);
    setMsg(null);
    try {
      const t = await devIssueLicense("pro");
      await activateLicense(t);
      setMsg({ ok: true, text: "Test Pro license issued & activated." });
      await onActivated();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not issue a test license." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lic-activate">
      <p className="opt-label">Activate a license</p>
      <textarea value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste your Supreme license token (.slic contents)…" rows={3} />
      <div className="dev-row2" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy || !token.trim()} onClick={() => activate()}>Activate</button>
        <label className="chip" style={{ cursor: "pointer" }}>
          Import file…
          <input type="file" accept=".slic,.json,application/json" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
        </label>
        {devMode && <button disabled={busy} onClick={issueTest}>Issue &amp; activate test Pro license</button>}
      </div>
      {msg && <p className={msg.ok ? "muted" : "err"}>{msg.text}</p>}
    </div>
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
