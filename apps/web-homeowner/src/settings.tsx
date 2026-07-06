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
import { AdvancedSettings } from "./advanced.js";
import {
  activeHomeId,
  addHome,
  loadHomes,
  removeHome,
  setActiveHome,
  testHome,
  type Home,
} from "./homes.js";

/**
 * Settings (§11.2/§11.3) — a calm, Ovio-style menu. The default view is a short list of destinations;
 * choosing one opens that focused panel with a back arrow, so nothing is crammed onto one screen.
 * Everything binds to the Supreme API — zero Home Assistant awareness.
 */
type SettingsPage = { id: string; label: string; icon: string; hint: string; el: React.ReactNode };

export function ThemeSettings() {
  const [open, setOpen] = useState<string | null>(null);

  // Extensions & Developer are now top-level navigation destinations, so they're no longer here.
  const pages: SettingsPage[] = [
    { id: "appearance", label: "Appearance", icon: "◐", hint: "Theme & accent", el: <AppearanceSettings /> },
    { id: "homes", label: "Homes", icon: "⌂", hint: "Switch or add a home", el: <HomesSettings /> },
    { id: "license", label: "Licensing", icon: "◆", hint: "Plan, features & activation", el: <LicensingSettings /> },
    { id: "advanced", label: "Advanced", icon: "⚙", hint: "Circadian, climate, energy", el: <AdvancedSettings /> },
    { id: "account", label: "Account", icon: "○", hint: "Email, password & account", el: <AccountSettings /> },
    { id: "security", label: "Security & sign-in", icon: "⛨", hint: "Active sessions & devices", el: <SecuritySettings /> },
  ];

  const current = pages.find((p) => p.id === open);
  if (current) {
    return (
      <div className="settings">
        <button className="back" onClick={() => setOpen(null)}>‹ Settings</button>
        {current.el}
      </div>
    );
  }

  return (
    <div className="settings">
      <h1 className="title">Settings</h1>
      <div className="set-menu">
        {pages.map((p) => (
          <button key={p.id} className="set-row" onClick={() => setOpen(p.id)}>
            <span className="set-ic">{p.icon}</span>
            <span className="set-meta">
              <span className="set-label">{p.label}</span>
              <span className="set-hint">{p.hint}</span>
            </span>
            <span className="set-chev">›</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Appearance: base palette (Luxury Black/White/Auto) + accent (Gold/Silver). A pure repaint. */
function AppearanceSettings() {
  const [choice, setChoice] = useState(loadAureonTheme());
  function update(next: { mode?: AureonMode; accent?: AureonAccent }) {
    const merged = { ...choice, ...next };
    setChoice(merged);
    applyAureonTheme(merged);
    saveAureonTheme(merged);
  }
  return (
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
  );
}

/**
 * Homes (§16): manage the homes this browser can reach and switch the active one. Each home is one
 * hub at a base URL; switching writes the local registry and reloads so every screen rebinds to the
 * new hub (each home keeps its own saved session, so no re-login). "Add a home" is the setup screen
 * — name + hub address, with a reachability check.
 */
function HomesSettings() {
  const [homes, setHomes] = useState<Home[]>(loadHomes());
  const [activeId, setActiveId] = useState(activeHomeId());
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function switchTo(id: string) {
    if (id === activeId) return;
    setActiveHome(id);
    // A home is a different hub + session — reload so every screen rebinds cleanly to it.
    window.location.reload();
  }

  async function probe() {
    if (!url.trim()) return;
    setBusy(true);
    setCheck(null);
    const res = await testHome(url);
    setCheck(
      res.ok
        ? { ok: true, text: `Reachable${res.systemName ? ` · ${res.systemName}` : ""}` }
        : { ok: false, text: "Couldn't reach a Supreme hub at that address." },
    );
    setBusy(false);
  }

  function add() {
    if (!url.trim()) return;
    const next = addHome(name, url);
    setHomes(next);
    setName("");
    setUrl("");
    setCheck(null);
    setAdding(false);
  }

  function remove(id: string) {
    const next = removeHome(id);
    setHomes(next);
    setActiveId(activeHomeId());
  }

  return (
    <section className="card-section">
      <h2 className="section-title">Homes</h2>
      <p className="muted" style={{ marginTop: -4 }}>Switch between the homes you can reach. Each home is one Supreme hub.</p>
      <div className="home-list">
        {homes.map((h) => (
          <div key={h.id} className={`home-row${h.id === activeId ? " active" : ""}`}>
            <button className="home-pick" onClick={() => switchTo(h.id)}>
              <span className="home-dot">{h.id === activeId ? "●" : "○"}</span>
              <span className="home-meta">
                <span className="home-name">{h.name}</span>
                <span className="home-url">{h.baseUrl}</span>
              </span>
              {h.id === activeId && <span className="chip">Active</span>}
            </button>
            {homes.length > 1 && (
              <button className="home-remove" title="Remove home" onClick={() => remove(h.id)}>✕</button>
            )}
          </div>
        ))}
      </div>

      {adding ? (
        <div className="card" style={{ marginTop: 10 }}>
          <p className="opt-label">Add a home</p>
          <input placeholder="Home name (e.g. Dubai Apartment)" value={name} onChange={(e) => setName(e.target.value)} />
          <div style={{ height: 8 }} />
          <input placeholder="Hub address (e.g. http://192.168.1.20:8080)" value={url} onChange={(e) => { setUrl(e.target.value); setCheck(null); }} />
          {check && <p className={check.ok ? "muted" : "err"} style={{ marginTop: 6 }}>{check.text}</p>}
          <div className="dev-row2" style={{ marginTop: 8 }}>
            <button disabled={busy || !url.trim()} onClick={probe}>{busy ? "Checking…" : "Test connection"}</button>
            <button className="primary" disabled={!url.trim()} onClick={add}>Add home</button>
            <button onClick={() => { setAdding(false); setCheck(null); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="primary" style={{ marginTop: 10 }} onClick={() => setAdding(true)}>+ Add a home</button>
      )}
    </section>
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

      <ChangeEmail />

      <p className="opt-label" style={{ marginTop: 18 }}>Change password</p>
      <PasswordInput value={current} onChange={setCurrent} placeholder="Current password" />
      <div style={{ height: 8 }} />
      <PasswordInput value={next} onChange={setNext} placeholder="New password (min 8 characters)" />
      <div style={{ height: 8 }} />
      <PasswordInput value={confirm} onChange={setConfirm} placeholder="Confirm new password" />
      {msg && <p className={msg.ok ? "muted" : "err"}>{msg.text}</p>}
      <button className="primary" disabled={busy || !current || !next} onClick={change} style={{ marginTop: 10 }}>
        {busy ? "Updating…" : "Update password"}
      </button>

      <DeleteAccount />
    </section>
  );
}

/** Change the signed-in user's email/username (re-auth with the current password). */
function ChangeEmail() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setMsg(null);
    setBusy(true);
    try {
      const { user } = await client.changeEmail(email.trim(), password);
      setEmail("");
      setPassword("");
      setMsg({ ok: true, text: `Email updated to ${user.email}.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not change the email." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="opt-label">Change email / username</p>
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="New email address" />
      <div style={{ height: 8 }} />
      <PasswordInput value={password} onChange={setPassword} placeholder="Current password" />
      {msg && <p className={msg.ok ? "muted" : "err"}>{msg.text}</p>}
      <button className="primary" disabled={busy || !email.trim() || !password} onClick={submit} style={{ marginTop: 10 }}>
        {busy ? "Updating…" : "Update email"}
      </button>
    </>
  );
}

/**
 * Security & sign-in (§ Security Center). Lists the user's login sessions (active + recent), flags
 * the current device, and supports remote logout — sign out a single session or everywhere else.
 * IP / device / last-seen shown when captured (older sessions predate capture).
 */
type SessionRow = { id: string; createdAt: string; lastSeenAt: string | null; ip: string | null; userAgent: string | null; revoked: boolean; current: boolean };

function SecuritySettings() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    try {
      const res = await client.sessions();
      setSessions(res.sessions as SessionRow[]);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not load sessions." });
    }
  }
  useEffect(() => { void load(); }, []);

  async function revoke(id: string) {
    setBusy(id); setMsg(null);
    try { await client.revokeSession(id); await load(); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not sign out that session." }); }
    finally { setBusy(null); }
  }
  async function revokeOthers() {
    setBusy("others"); setMsg(null);
    try { const { revoked } = await client.revokeOtherSessions(); await load(); setMsg({ ok: true, text: revoked ? `Signed out ${revoked} other session${revoked === 1 ? "" : "s"}.` : "No other sessions." }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not sign out other sessions." }); }
    finally { setBusy(null); }
  }

  const active = (sessions ?? []).filter((s) => !s.revoked);
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");

  return (
    <section className="card-section">
      <h2 className="section-title">Security &amp; sign-in</h2>
      <p className="muted" style={{ marginTop: -4 }}>Devices signed in to your account. Sign out any you don’t recognise.</p>

      {sessions === null && <p className="muted">Loading…</p>}
      {sessions && active.length > 1 && (
        <button disabled={busy === "others"} onClick={revokeOthers} style={{ marginBottom: 12 }}>
          {busy === "others" ? "Signing out…" : "Sign out all other sessions"}
        </button>
      )}

      <div className="sess-list">
        {(sessions ?? []).filter((s) => !s.revoked).map((s) => (
          <div key={s.id} className={`sess-row${s.current ? " current" : ""}`}>
            <span className="sess-ic">🖥️</span>
            <span className="sess-meta">
              <span className="sess-name">{s.userAgent ? shortAgent(s.userAgent) : "Unknown device"}{s.current && <span className="chip"> This device</span>}</span>
              <span className="sess-sub">{s.ip ?? "IP unknown"} · signed in {fmt(s.createdAt)}{s.lastSeenAt ? ` · last active ${fmt(s.lastSeenAt)}` : ""}</span>
            </span>
            {!s.current && (
              <button className="danger" disabled={busy === s.id} onClick={() => revoke(s.id)}>{busy === s.id ? "…" : "Sign out"}</button>
            )}
          </div>
        ))}
      </div>

      {msg && <p className={msg.ok ? "muted" : "err"}>{msg.text}</p>}
    </section>
  );
}

/** Condense a UA string to something a person recognises ("Chrome on macOS"). Best-effort, real data. */
function shortAgent(ua: string): string {
  const os = /Windows/i.test(ua) ? "Windows" : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Mac OS X|Macintosh/i.test(ua) ? "macOS" : /Android/i.test(ua) ? "Android" : /Linux/i.test(ua) ? "Linux" : "";
  const br = /Edg\//i.test(ua) ? "Edge" : /Chrome\//i.test(ua) ? "Chrome" : /Safari\//i.test(ua) ? "Safari" : /Firefox\//i.test(ua) ? "Firefox" : /Dart|supreme/i.test(ua) ? "Supreme app" : "";
  return [br, os].filter(Boolean).join(" on ") || ua.slice(0, 40);
}

/** Danger zone — permanently delete your own account (re-auth + explicit confirm). */
function DeleteAccount() {
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function del() {
    setErr(null);
    setBusy(true);
    try {
      await client.deleteAccount(password);
      // The account (and its sessions) are gone — bounce back to the login screen.
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not delete the account.");
      setBusy(false);
    }
  }

  return (
    <div className="danger-zone">
      <p className="opt-label danger-label">Delete account</p>
      <p className="muted">Permanently deletes your account and signs you out everywhere. This can’t be undone. The home owner (master) account can’t be deleted.</p>
      {!confirming ? (
        <button className="danger" onClick={() => setConfirming(true)} style={{ marginTop: 8 }}>Delete my account…</button>
      ) : (
        <>
          <PasswordInput value={password} onChange={setPassword} placeholder="Confirm with your current password" />
          {err && <p className="err">{err}</p>}
          <div className="dev-row2" style={{ marginTop: 8 }}>
            <button className="danger" disabled={busy || !password} onClick={del}>{busy ? "Deleting…" : "Permanently delete"}</button>
            <button disabled={busy} onClick={() => { setConfirming(false); setPassword(""); setErr(null); }}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
