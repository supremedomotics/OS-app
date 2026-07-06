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
import { PasskeysSection } from "./passkeys.js";
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
    { id: "notifications", label: "Notifications", icon: "◔", hint: "Alerts & activity", el: <NotificationCenter /> },
    { id: "account", label: "Account", icon: "○", hint: "Email, password & account", el: <AccountSettings /> },
    { id: "security", label: "Security & sign-in", icon: "⛨", hint: "Active sessions & devices", el: <SecuritySettings /> },
    { id: "backup", label: "Backup & restore", icon: "❖", hint: "Backups, schedule & restore", el: <BackupCenter /> },
    { id: "update", label: "Software update", icon: "⤓", hint: "Version & updates", el: <UpdateCenter /> },
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

      <VerifyEmail />
      <ChangeEmail />

      <p className="opt-label" style={{ marginTop: 18 }}>Change password</p>
      <PasswordInput value={current} onChange={setCurrent} placeholder="Current password" />
      <div style={{ height: 8 }} />
      <PasswordInput value={next} onChange={setNext} placeholder="New password (min 8 characters)" />
      {next.length > 0 && <PasswordStrength value={next} />}
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

/** A password strength meter (§ password policies) — mirrors the hub's structural score 0..4. */
function PasswordStrength({ value }: { value: string }) {
  let score = 0;
  if (value.length >= 8) score++;
  if (value.length >= 12) score++;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
  if (/[0-9]/.test(value)) score++;
  if (/[^a-zA-Z0-9]/.test(value)) score++;
  score = Math.min(4, score);
  const labels = ["Very weak", "Weak", "Fair", "Good", "Strong"];
  const colors = ["var(--aureon-color-status-critical)", "var(--aureon-color-status-critical)", "var(--aureon-color-status-warning)", "var(--aureon-color-status-good)", "var(--aureon-color-status-good)"];
  return (
    <div className="pw-strength">
      <span className="pw-bar"><span className="pw-fill" style={{ width: `${(score / 4) * 100}%`, background: colors[score] }} /></span>
      <span className="pw-label" style={{ color: colors[score] }}>{labels[score]}</span>
    </div>
  );
}

/**
 * Email verification (§ Authentication). Shows whether the signed-in user's email is verified and,
 * if not, lets them request a verification link. On a local hub (non-production) the token is
 * returned and applied immediately; in production it's delivered by email (the integration point).
 */
function VerifyEmail() {
  const [user, setUser] = useState<{ email: string; emailVerified: boolean } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() { try { setUser((await client.me()).user); } catch { /* keep */ } }
  useEffect(() => { void load(); }, []);

  async function verify() {
    setBusy(true); setMsg(null);
    try {
      const res = await client.requestEmailVerification();
      if (res.token) { await client.verifyEmail(res.token); await load(); setMsg({ ok: true, text: "Email verified." }); }
      else if (res.alreadyVerified) { await load(); }
      else setMsg({ ok: true, text: "Verification email sent — check your inbox." });
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not verify." }); }
    finally { setBusy(false); }
  }

  if (!user) return null;
  return (
    <div className="verify-email" style={{ marginBottom: 14 }}>
      <p className="opt-label" style={{ margin: 0 }}>
        {user.email}{" "}
        {user.emailVerified
          ? <span className="tag ok">Verified</span>
          : <span className="tag" style={{ color: "var(--aureon-color-status-warning)", borderColor: "color-mix(in srgb, var(--aureon-color-status-warning) 45%, transparent)" }}>Not verified</span>}
      </p>
      {!user.emailVerified && (
        <button disabled={busy} onClick={verify} style={{ marginTop: 8 }}>{busy ? "Verifying…" : "Verify email"}</button>
      )}
      {msg && <p className={msg.ok ? "muted" : "err"} style={{ marginTop: 6 }}>{msg.text}</p>}
    </div>
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

      <RecoveryCodes />
      <PasskeysSection />
      <ApiTokens />
    </section>
  );
}

/**
 * Personal API tokens (§ Security Center). Long-lived Bearer credentials for scripts/integrations.
 * The token is shown once at creation (only a hash is stored); each can be revoked independently.
 */
type ApiToken = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null };

function ApiTokens() {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() { try { setTokens((await client.apiTokens()).tokens as ApiToken[]); } catch { /* keep */ } }
  useEffect(() => { void load(); }, []);

  async function create() {
    setBusy(true);
    try { const res = await client.createApiToken(name.trim() || "API token"); setCreated(res.token); setName(""); await load(); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true);
    try { await client.revokeApiToken(id); await load(); }
    finally { setBusy(false); }
  }

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString([], { dateStyle: "medium" }) : "never");
  return (
    <div className="danger-zone" style={{ borderTopColor: "var(--aureon-color-base-hairline)" }}>
      <p className="opt-label">API tokens</p>
      <p className="muted">Long-lived tokens for scripts and integrations. Treat them like passwords.</p>

      {created && (
        <div className="update-avail" style={{ marginTop: 8 }}>
          <strong>New token</strong>
          <code style={{ display: "block", marginTop: 6, fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>{created}</code>
          <p className="err" style={{ marginTop: 4 }}>Copy it now — it won't be shown again.</p>
          <button style={{ marginTop: 4 }} onClick={() => setCreated(null)}>Done</button>
        </div>
      )}

      <div className="sess-list" style={{ marginTop: 8 }}>
        {(tokens ?? []).map((t) => (
          <div key={t.id} className="sess-row">
            <span className="sess-ic">🔑</span>
            <span className="sess-meta">
              <span className="sess-name">{t.name} <code className="muted">{t.prefix}…</code></span>
              <span className="sess-sub">created {fmt(t.createdAt)} · last used {fmt(t.lastUsedAt)}</span>
            </span>
            <button className="danger" disabled={busy} onClick={() => revoke(t.id)}>Revoke</button>
          </div>
        ))}
      </div>

      <div className="dev-row2" style={{ marginTop: 8 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Token name (e.g. Backup script)" />
        <button className="primary" disabled={busy} onClick={create}>{busy ? "…" : "Create token"}</button>
      </div>
    </div>
  );
}

/**
 * MFA recovery codes (§ Security Center). One-time backup codes to sign in if the authenticator is
 * lost. Codes are shown once on generation (only hashes are stored); regenerating replaces them.
 */
function RecoveryCodes() {
  const [status, setStatus] = useState<{ mfaEnabled: boolean; remaining: number } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() { try { setStatus(await client.recoveryCodeStatus()); } catch { /* keep */ } }
  useEffect(() => { void load(); }, []);

  async function generate() {
    setBusy(true);
    try { const res = await client.generateRecoveryCodes(); setCodes(res.codes); await load(); }
    finally { setBusy(false); }
  }

  return (
    <div className="danger-zone" style={{ borderTopColor: "var(--aureon-color-base-hairline)" }}>
      <p className="opt-label">Recovery codes</p>
      {!status ? (
        <p className="muted">Loading…</p>
      ) : !status.mfaEnabled ? (
        <p className="muted">Enable two-factor authentication to set up recovery codes.</p>
      ) : (
        <>
          <p className="muted">One-time codes to sign in if you lose your authenticator. {status.remaining} unused.</p>
          {codes && (
            <div className="recovery-codes">
              {codes.map((c) => <code key={c}>{c}</code>)}
              <p className="err" style={{ gridColumn: "1 / -1" }}>Save these now — they won't be shown again.</p>
            </div>
          )}
          <button disabled={busy} onClick={generate} style={{ marginTop: 8 }}>
            {busy ? "Generating…" : status.remaining > 0 ? "Regenerate codes" : "Generate recovery codes"}
          </button>
        </>
      )}
    </div>
  );
}

/** Condense a UA string to something a person recognises ("Chrome on macOS"). Best-effort, real data. */
function shortAgent(ua: string): string {
  const os = /Windows/i.test(ua) ? "Windows" : /iPhone|iPad|iOS/i.test(ua) ? "iOS" : /Mac OS X|Macintosh/i.test(ua) ? "macOS" : /Android/i.test(ua) ? "Android" : /Linux/i.test(ua) ? "Linux" : "";
  const br = /Edg\//i.test(ua) ? "Edge" : /Chrome\//i.test(ua) ? "Chrome" : /Safari\//i.test(ua) ? "Safari" : /Firefox\//i.test(ua) ? "Firefox" : /Dart|supreme/i.test(ua) ? "Supreme app" : "";
  return [br, os].filter(Boolean).join(" on ") || ua.slice(0, 40);
}

/**
 * Notification Center (§ Notification Center). The full activity feed the hub already generates
 * (device offline, security events, automation results), with unread state and read receipts — all
 * from the real /v1/notifications backend; no new data invented.
 */
type NotifRow = { id: string; level: "info" | "warning" | "critical"; title: string; body: string; createdAt: string; readAt: string | null };

function NotificationCenter() {
  const [items, setItems] = useState<NotifRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await client.notifications();
    setItems(res.notifications as NotifRow[]);
  }
  useEffect(() => { void load(); }, []);

  async function markRead(ids: string[]) {
    if (ids.length === 0) return;
    setBusy(true);
    try { await client.markNotificationsRead(ids); await load(); } finally { setBusy(false); }
  }

  const unread = (items ?? []).filter((n) => !n.readAt);
  const dot = (l: string) => (l === "critical" ? "var(--aureon-color-status-critical)" : l === "warning" ? "var(--aureon-color-status-warning)" : "var(--aureon-color-status-good)");
  const fmt = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

  return (
    <section className="card-section">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h2 className="section-title" style={{ margin: 0 }}>Notifications{unread.length > 0 ? ` · ${unread.length} new` : ""}</h2>
        {unread.length > 0 && <button disabled={busy} onClick={() => markRead(unread.map((n) => n.id))}>Mark all read</button>}
      </div>

      {items === null && <p className="muted">Loading…</p>}
      {items && items.length === 0 && <p className="muted">No notifications yet.</p>}

      <div className="notif-list">
        {(items ?? []).map((n) => (
          <button key={n.id} className={`notif-row${n.readAt ? " read" : ""}`} disabled={busy || Boolean(n.readAt)} onClick={() => markRead([n.id])}>
            <span className="notif-dot" style={{ background: dot(n.level) }} />
            <span className="notif-meta">
              <span className="notif-title">{n.title}</span>
              {n.body && <span className="notif-body">{n.body}</span>}
              <span className="notif-time">{fmt(n.createdAt)}</span>
            </span>
            {!n.readAt && <span className="notif-new">New</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Update Center (§ Update Center). Shows the hub's current version and, when a signed OTA channel is
 * configured, whether a newer verified release exists (with its notes). No channel configured → it
 * honestly says so rather than implying an update state.
 */
type UpdateInfo = { current: string; channelConfigured: boolean; updateAvailable: boolean; latest?: { version: string; notes?: string; releasedAt: string }; checkedAt: string; error?: string };

function UpdateCenter() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function check() {
    setBusy(true); setErr(null);
    try { setInfo((await client.systemUpdate()) as UpdateInfo); }
    catch (e) { setErr(e instanceof Error ? e.message : "Could not check for updates."); }
    finally { setBusy(false); }
  }
  useEffect(() => { void check(); }, []);

  return (
    <section className="card-section">
      <h2 className="section-title">Software update</h2>
      <div className="lic-grid">
        <div><span className="k">Current version</span><span className="v">{info ? `v${info.current}` : "—"}</span></div>
        <div><span className="k">Update channel</span><span className="v">{info ? (info.channelConfigured ? "Configured" : "Not configured") : "—"}</span></div>
        <div><span className="k">Status</span><span className="v">{!info ? "—" : info.updateAvailable ? `Update available (v${info.latest?.version})` : "Up to date"}</span></div>
        {info?.checkedAt && <div><span className="k">Last checked</span><span className="v">{new Date(info.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>}
      </div>

      {info?.updateAvailable && info.latest && (
        <div className="update-avail">
          <strong>Version {info.latest.version} is available</strong>
          <span className="muted"> · released {new Date(info.latest.releasedAt).toLocaleDateString()}</span>
          {info.latest.notes && <p className="notif-body" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{info.latest.notes}</p>}
          <p className="muted" style={{ marginTop: 6 }}>The hub verifies and installs signed releases automatically (staged, rollback-safe).</p>
        </div>
      )}
      {info && !info.channelConfigured && <p className="muted">No update channel is configured on this hub. Updates are managed by your installer.</p>}
      {info?.error && <p className="err">Update check failed: {info.error}</p>}

      <button disabled={busy} onClick={check} style={{ marginTop: 12 }}>{busy ? "Checking…" : "Check for updates"}</button>
      {err && <p className="err">{err}</p>}
    </section>
  );
}

/**
 * Backup & restore (§ Backup). Real backup health (last/next/count), one-tap backup (downloaded +
 * kept in the hub's signed history), an automatic schedule, a re-downloadable history, and a
 * rollback-safe restore that previews (dry-run) before it commits.
 */
type BackupStatusT = { lastBackupAt: string | null; lastBackupSource: string | null; backupCount: number; schedule: { enabled: boolean; everyHours: number; retain: number }; nextDueAt: string | null; lastRestoreAt: string | null };
type BackupEntry = { id: string; createdAt: string; rowCount: number; tableCount: number; source: string };
type Inspection = { signatureValid: boolean | null; schemaVersion: string; createdAt: string; tableCount: number; rowCount: number; tables: { name: string; rows: number }[] };

function BackupCenter() {
  const [status, setStatus] = useState<BackupStatusT | null>(null);
  const [history, setHistory] = useState<BackupEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // The document being restored — when set, the guided Restore Wizard opens.
  const [wizardDoc, setWizardDoc] = useState<string | null>(null);

  async function load() {
    const [st, list] = await Promise.all([client.backupStatus(), client.backupList()]);
    setStatus(st as BackupStatusT);
    setHistory(list.backups as BackupEntry[]);
  }
  useEffect(() => { void load(); }, []);

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Never");

  function download(name: string, doc: string) {
    const blob = new Blob([doc], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }

  async function createNow() {
    setBusy("create"); setMsg(null);
    try {
      const { meta, document: doc } = await client.backup();
      download(`supreme-backup-${meta.id}.slic`, doc);
      await load();
      setMsg({ ok: true, text: "Backup created and downloaded." });
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Backup failed." }); }
    finally { setBusy(null); }
  }

  async function reDownload(id: string) {
    setBusy(id);
    try { const { document: doc } = await client.getBackup(id); download(`supreme-backup-${id}.slic`, doc); }
    finally { setBusy(null); }
  }

  async function saveSchedule(patch: { enabled?: boolean; everyHours?: number; retain?: number }) {
    setBusy("schedule");
    try { const { schedule } = await client.setBackupSchedule(patch); setStatus((s) => (s ? { ...s, schedule } : s)); await load(); }
    finally { setBusy(null); }
  }

  /** Open the Restore Wizard for a stored history entry (fetches its document). */
  async function restoreFromHistory(id: string) {
    setBusy(id); setMsg(null);
    try { const { document: doc } = await client.getBackup(id); setWizardDoc(doc); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not load that backup." }); }
    finally { setBusy(null); }
  }

  const sched = status?.schedule;
  const healthy = status && status.lastBackupAt && (!sched?.enabled || (status.nextDueAt ? new Date(status.nextDueAt).getTime() > Date.now() - 3_600_000 : true));

  return (
    <section className="card-section">
      <h2 className="section-title">Backup &amp; restore</h2>

      {/* Health indicator */}
      <div className={`health-hero ${status ? (healthy ? "ok" : "warn") : ""}`}>
        <span className="hh-dot" />
        <div>
          <strong>{!status ? "Checking…" : status.lastBackupAt ? "Backups healthy" : "No backups yet"}</strong>
          <span className="hh-sub">{status ? `Last backup ${fmt(status.lastBackupAt)} · ${status.backupCount} kept${status.lastRestoreAt ? ` · last restore ${fmt(status.lastRestoreAt)}` : ""}` : ""}</span>
        </div>
      </div>

      <div className="dev-row2" style={{ marginTop: 12 }}>
        <button className="primary" disabled={busy === "create"} onClick={createNow}>{busy === "create" ? "Creating…" : "Back up now"}</button>
      </div>

      {/* Schedule */}
      <p className="opt-label" style={{ marginTop: 18 }}>Automatic backups</p>
      {sched && (
        <>
          <label className="dev-toggle">
            <input type="checkbox" checked={sched.enabled} disabled={busy === "schedule"} onChange={(e) => saveSchedule({ enabled: e.target.checked })} />
            <span>Automatically back up on a schedule</span>
          </label>
          {sched.enabled && (
            <div className="lic-grid" style={{ marginTop: 8 }}>
              <label className="drv-field"><span className="lbl">Every (hours)</span>
                <input type="number" min={1} defaultValue={sched.everyHours} onBlur={(e) => saveSchedule({ everyHours: Math.max(1, Number.parseInt(e.target.value, 10) || sched.everyHours) })} />
              </label>
              <label className="drv-field"><span className="lbl">Keep (backups)</span>
                <input type="number" min={1} defaultValue={sched.retain} onBlur={(e) => saveSchedule({ retain: Math.max(1, Number.parseInt(e.target.value, 10) || sched.retain) })} />
              </label>
              {status?.nextDueAt && <div><span className="k">Next backup</span><span className="v">{fmt(status.nextDueAt)}</span></div>}
            </div>
          )}
        </>
      )}

      {/* History */}
      {history.length > 0 && (
        <>
          <p className="opt-label" style={{ marginTop: 18 }}>Backup history</p>
          <div className="sess-list">
            {history.map((b) => (
              <div key={b.id} className="sess-row">
                <span className="sess-ic">❖</span>
                <span className="sess-meta">
                  <span className="sess-name">{fmt(b.createdAt)} <span className="tag soft">{b.source}</span></span>
                  <span className="sess-sub">{b.rowCount} rows · {b.tableCount} tables</span>
                </span>
                <button disabled={busy === b.id} onClick={() => reDownload(b.id)}>Download</button>
                <button disabled={busy === b.id} onClick={() => restoreFromHistory(b.id)}>Restore…</button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Restore from a file → opens the guided Restore Wizard */}
      <p className="opt-label" style={{ marginTop: 18 }}>Restore from a file</p>
      <label className="chip" style={{ cursor: "pointer", display: "inline-block" }}>
        Choose a .slic backup…
        <input type="file" accept=".slic,.json,application/json" style={{ display: "none" }} onChange={async (e) => { const f = e.target.files?.[0]; if (f) setWizardDoc(await f.text()); e.target.value = ""; }} />
      </label>

      {msg && <p className={msg.ok ? "muted" : "err"} style={{ marginTop: 10 }}>{msg.text}</p>}

      {wizardDoc !== null && (
        <RestoreWizard
          document={wizardDoc}
          fmt={fmt}
          onClose={() => setWizardDoc(null)}
          onDone={async (r) => { setWizardDoc(null); await load(); setMsg({ ok: true, text: `Restored ${r.rows} rows across ${r.tables} tables.` }); }}
        />
      )}
    </section>
  );
}

/**
 * Restore Wizard (§ Backup — restore wizard). A guided, safe restore: Preview (dry-run — verify the
 * signature + show exactly what will be written) → Confirm (explicit warning; a rollback snapshot is
 * taken first) → Result. Drives the rollback-safe restore endpoint already on the hub.
 */
function RestoreWizard({ document: doc, fmt, onClose, onDone }: {
  document: string; fmt: (iso: string | null) => string; onClose: () => void; onDone: (r: { tables: number; rows: number }) => void;
}) {
  const [step, setStep] = useState<"preview" | "confirm" | "running">("preview");
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    client.inspectRestore(doc.trim())
      .then((r) => { if (live) setInspection(r.inspection as Inspection); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : "Could not read that backup."); });
    return () => { live = false; };
  }, [doc]);

  async function run() {
    setStep("running"); setErr(null);
    try { onDone(await client.restore(doc.trim())); }
    catch (e) { setErr(e instanceof Error ? e.message : "Restore failed (rolled back)."); setStep("confirm"); }
  }

  const invalid = inspection?.signatureValid === false;
  return (
    <div className="more-sheet" onClick={onClose}>
      <div className="more-panel wizard" onClick={(e) => e.stopPropagation()}>
        <div className="more-grip" />
        <h3 className="section" style={{ marginTop: 0 }}>Restore backup</h3>

        <ol className="wiz-steps">
          <li className={step === "preview" ? "on" : "done"}>1 · Review</li>
          <li className={step === "confirm" ? "on" : step === "running" ? "done" : ""}>2 · Confirm</li>
          <li className={step === "running" ? "on" : ""}>3 · Restore</li>
        </ol>

        {!inspection && !err && <p className="muted">Reading backup…</p>}
        {err && <p className="err">{err}</p>}

        {inspection && (
          <>
            <div className={`update-avail ${invalid ? "" : ""}`} style={invalid ? { borderColor: "var(--aureon-color-status-critical)" } : undefined}>
              <strong>{invalid ? "⚠ Invalid signature" : "✓ Verified backup"}</strong>
              <span className="muted"> · from {fmt(inspection.createdAt)} · {inspection.rowCount} rows across {inspection.tableCount} tables</span>
              <p className="notif-body" style={{ marginTop: 6 }}>{inspection.tables.map((t) => `${t.name} (${t.rows})`).join(", ")}</p>
            </div>

            {step === "confirm" && (
              <p className="err" style={{ marginTop: 10 }}>This replaces all current data with the backup. A rollback snapshot is taken first, so a failed restore is automatically undone — but a successful restore can’t be reversed except by restoring another backup.</p>
            )}

            <div className="dev-row2" style={{ marginTop: 12 }}>
              {step === "preview" && <button className="primary" disabled={invalid} onClick={() => setStep("confirm")}>Continue</button>}
              {step === "confirm" && <button className="danger" onClick={run}>Restore now</button>}
              {step === "running" && <button className="danger" disabled>Restoring…</button>}
              <button disabled={step === "running"} onClick={onClose}>Cancel</button>
            </div>
            {invalid && <p className="muted" style={{ marginTop: 6 }}>This backup’s signature didn’t verify — restore is blocked to protect your hub.</p>}
          </>
        )}
      </div>
    </div>
  );
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
