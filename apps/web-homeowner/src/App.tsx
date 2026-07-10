import { useEffect, useRef, useState } from "react";
import type { SupremeStream } from "@supreme/sdk";
import { client, fetchLicense, fetchSetupStatus, onSessionExpired, openStream, type SetupStatus } from "./api.js";
import { LiveContext, type LiveStates } from "./live.js";
import { Energy, RoomsScreen, Scenes, Security } from "./screens.js";
import { ForgotPassword, SetupWizard } from "./onboarding.js";
import { PasswordInput } from "./password-input.js";
import { ThemeSettings, NotificationCenter } from "./settings.js";
import { Automations } from "./automations.js";
import { DiscoverDevices } from "./discover.js";
import { DeviceManager } from "./devices.js";
import { Media } from "./media.js";
import { ExtensionCenter } from "./extensions.js";
import { DashboardOverview } from "./dashboard.js";
import { DeveloperTools } from "./developer.js";
import { AreasScreen } from "./areas.js";
import { CommandPalette } from "./palette.js";
import { passkeysSupported, signInWithPasskey } from "./passkeys.js";
import { Icon } from "./icons.js";

export type Tab =
  | "dashboard" | "discover" | "devices" | "extensions"
  | "automations" | "scenes" | "rooms" | "areas" | "media" | "security" | "energy" | "notifications" | "settings" | "developer";
type NavIcon = "dashboard" | "discover" | "devices" | "extensions" | "automations" | "scenes" | "rooms" | "areas" | "media" | "security" | "energy" | "notifications" | "settings" | "developer";

// The full platform navigation (§ Navigation). Nothing is hidden behind URLs — every backend area is
// a first-class destination. "developer" appears only in Developer Mode.
const NAV: { id: Tab; label: string; icon: NavIcon; dev?: boolean }[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "discover", label: "Discover Devices", icon: "discover" },
  { id: "devices", label: "Devices", icon: "devices" },
  { id: "extensions", label: "Extension Center", icon: "extensions" },
  { id: "automations", label: "Automations", icon: "automations" },
  { id: "scenes", label: "Scenes", icon: "scenes" },
  { id: "rooms", label: "Rooms", icon: "rooms" },
  { id: "areas", label: "Areas", icon: "areas" },
  { id: "media", label: "Media", icon: "media" },
  { id: "security", label: "Security", icon: "security" },
  { id: "energy", label: "Energy", icon: "energy" },
  { id: "notifications", label: "Notifications", icon: "notifications" },
  { id: "settings", label: "Settings", icon: "settings" },
  { id: "developer", label: "Developer", icon: "developer", dev: true },
];
// On a narrow (phone) bottom bar we surface the everyday five; the rest live behind "More" — a
// visible menu, never hidden functionality.
const PRIMARY: Tab[] = ["dashboard", "rooms", "scenes", "security", "settings"];

function useWide(): boolean {
  const [wide, setWide] = useState(typeof window !== "undefined" && window.innerWidth >= 900);
  useEffect(() => {
    const on = () => setWide(window.innerWidth >= 900);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return wide;
}

export function App() {
  // A stored (non-expired-refresh) session survives a reload — the SDK silently refreshes the
  // access token as needed, so there's no reason to force a re-login just because the tab reloaded.
  const [authed, setAuthed] = useState(() => Boolean(client.accessToken));
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [states, setStates] = useState<LiveStates>({});
  const [devMode, setDevMode] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const streamRef = useRef<SupremeStream | null>(null);
  const wide = useWide();

  useEffect(() => { void fetchSetupStatus().then(setSetup); }, []);
  // Drop to the login screen only when the refresh token itself is dead (30-day expiry or revoked) —
  // never for a routine access-token rotation, which the SDK already handled silently.
  useEffect(() => onSessionExpired(() => setAuthed(false)), []);
  useEffect(() => { if (authed) void fetchLicense().then((l) => setDevMode(Boolean(l?.service?.devMode))); }, [authed]);
  // Global command palette: ⌘K / Ctrl-K toggles it from anywhere.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((v) => !v); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const apply = (deviceId: string, capability: string, state: unknown) =>
    setStates((s) => ({ ...s, [deviceId]: { ...s[deviceId], [capability]: state } }));

  useEffect(() => {
    if (!authed) return;
    const stream = openStream();
    if (!stream) return;
    streamRef.current = stream;
    stream.connect({ onOpen: () => stream.subscribe(["*"]), onState: (f) => apply(f.deviceId, f.state.kind, f.state) });
    return () => stream.close();
  }, [authed]);

  if (!authed && setup?.setupRequired) {
    return <SetupWizard status={setup} onDone={() => { setSetup({ ...setup, setupRequired: false }); setAuthed(true); }} />;
  }
  if (!authed) return <Login onAuthed={() => setAuthed(true)} />;

  const go = (t: Tab) => { if (t === "rooms") setSelectedRoom(null); setTab(t); setMoreOpen(false); };
  const items = NAV.filter((n) => !n.dev || devMode);
  const palette = paletteOpen ? (
    <CommandPalette
      navItems={items.map((n) => ({ id: n.id, label: n.label }))}
      onNavigate={go}
      onSelectRoom={setSelectedRoom}
      onClose={() => setPaletteOpen(false)}
    />
  ) : null;

  // Keyed on the active tab so switching destinations replays the enter transition (§ Animation).
  const page = (
    <div className="page-anim" key={tab}>
      {tab === "dashboard" && <DashboardOverview onNavigate={go} onOpenRoom={(id) => { setSelectedRoom(id); setTab("rooms"); }} devMode={devMode} />}
      {tab === "discover" && <DiscoverDevices />}
      {tab === "devices" && <DeviceManager onNavigate={go} devMode={devMode} />}
      {tab === "extensions" && <ExtensionCenter />}
      {tab === "automations" && <Automations />}
      {tab === "scenes" && <Scenes />}
      {tab === "rooms" && <RoomsScreen selected={selectedRoom} onSelect={setSelectedRoom} />}
      {tab === "areas" && <AreasScreen onNavigate={go} />}
      {tab === "media" && <Media onNavigate={go} />}
      {tab === "security" && <Security />}
      {tab === "energy" && <Energy />}
      {tab === "notifications" && <div className="page"><NotificationCenter /></div>}
      {tab === "settings" && <ThemeSettings />}
      {tab === "developer" && devMode && <DeveloperTools />}
    </div>
  );

  // Wide (tablet/desktop): a labelled left rail with every destination. Narrow (phone): a floating
  // icon bar of the everyday five + a "More" sheet. Same features, only the layout changes.
  if (wide) {
    return (
      <LiveContext.Provider value={{ states, apply }}>
        <div className="app-wide">
          <aside className="rail">
            <div className="rail-brand">Supreme</div>
            <button className="rail-search" onClick={() => setPaletteOpen(true)}>
              <span className="ic"><Icon name="discover" /></span><span>Search</span><kbd>⌘K</kbd>
            </button>
            <nav>
              {items.map((n) => (
                <button key={n.id} className={`rail-item${tab === n.id ? " active" : ""}`} onClick={() => go(n.id)}>
                  <span className="ic"><Icon name={n.icon} /></span><span>{n.label}</span>
                </button>
              ))}
            </nav>
            {devMode && <div className="rail-dev">DEVELOPMENT BUILD</div>}
          </aside>
          <main className="wide-content">{page}</main>
          {palette}
        </div>
      </LiveContext.Provider>
    );
  }

  const primary = items.filter((n) => PRIMARY.includes(n.id));
  const overflow = items.filter((n) => !PRIMARY.includes(n.id));
  return (
    <LiveContext.Provider value={{ states, apply }}>
      <div className="shell">
        <div className="content">{page}</div>
        <DevWatermark show={devMode} />
        {moreOpen && (
          <div className="more-sheet" onClick={() => setMoreOpen(false)}>
            <div className="more-panel" onClick={(e) => e.stopPropagation()}>
              <div className="more-grip" />
              <button className="set-row" onClick={() => { setMoreOpen(false); setPaletteOpen(true); }}>
                <span className="set-ic"><Icon name="discover" /></span>
                <span className="set-meta"><span className="set-label">Search</span></span>
                <span className="set-chev">›</span>
              </button>
              {overflow.map((n) => (
                <button key={n.id} className={`set-row${tab === n.id ? " active" : ""}`} onClick={() => go(n.id)}>
                  <span className="set-ic"><Icon name={n.icon} /></span>
                  <span className="set-meta"><span className="set-label">{n.label}</span></span>
                  <span className="set-chev">›</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <nav className="tabbar">
          {primary.map((t) => (
            <button key={t.id} className={t.id === tab ? "active" : ""} onClick={() => go(t.id)}>
              <span className="ic"><Icon name={t.icon} /></span><span className="lbl">{t.label}</span>
            </button>
          ))}
          <button className={`more-btn${overflow.some((o) => o.id === tab) ? " active" : ""}`} onClick={() => setMoreOpen((v) => !v)}>
            <span className="ic"><Icon name="extensions" /></span><span className="lbl">More</span>
          </button>
        </nav>
        {palette}
      </div>
    </LiveContext.Provider>
  );
}

/** A small persistent badge when the hub is in Developer Mode (every feature unlocked). */
function DevWatermark({ show }: { show: boolean }) {
  if (!show) return null;
  return <div className="dev-watermark">DEVELOPMENT BUILD · Developer License</div>;
}

function Login({ onAuthed }: { onAuthed: () => void }) {
  const [email, setEmail] = useState("owner@supreme.local");
  const [password, setPassword] = useState("supreme-owner-demo-pass");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await client.login(email.trim(), password);
      if (res.status === "ok") onAuthed();
      else setError("Two-factor authentication required");
    } catch (e) {
      // Surface the real reason (e.g. "invalid email or password") rather than a blanket message,
      // and give a hint when the hub looks unreachable.
      const msg = e instanceof Error ? e.message : "";
      setError(
        /failed to fetch|networkerror|load failed/i.test(msg)
          ? "Can't reach the hub. Check it's running and reachable."
          : msg && !/^\d+$/.test(msg)
            ? msg
            : "Could not sign in. Check your details.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (forgot) return <ForgotPassword onBack={() => setForgot(false)} />;

  return (
    <div className="login">
      <h1>Supreme</h1>
      <p className="muted">Welcome home.</p>
      <form onSubmit={submit}>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email or username" />
        <PasswordInput value={password} onChange={setPassword} placeholder="Password" />
        {error && <p className="err">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {passkeysSupported() && (
        <button
          className="link"
          onClick={async () => {
            setError(null);
            try { if (await signInWithPasskey()) onAuthed(); else setError("Passkey sign-in was cancelled."); }
            catch (e) { setError(e instanceof Error ? e.message : "Passkey sign-in failed."); }
          }}
          style={{ marginTop: 8 }}
        >
          🔐 Sign in with a passkey
        </button>
      )}
      <div className="login-actions">
        <button className="link" onClick={() => setForgot(true)}>
          Forgot password?
        </button>
        <button
          className="link"
          onClick={() => setError("New accounts are created by your home administrator in Settings → People.")}
        >
          Create new user
        </button>
      </div>
    </div>
  );
}
