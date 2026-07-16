import { useEffect, useRef, useState } from "react";
import type { SupremeStream } from "@supreme/sdk";
import { useAureonDensity } from "@supreme/aureon-web";
import { client, fetchLicense, fetchSetupStatus, onSessionExpired, openStream, type SetupStatus } from "./api.js";
import { LiveContext, type LiveStates } from "./live.js";
import { RoomsScreen, Scenes, Security } from "./screens.js";
import { Energy } from "./infrastructure-energy.js";
import { ForgotPassword, SetupWizard } from "./onboarding.js";
import { PasswordInput } from "./password-input.js";
import { ThemeSettings, NotificationCenter } from "./settings.js";
import { Automations } from "./automations.js";
import { DiscoverDevices } from "./discover.js";
import { DeviceManager } from "./devices.js";
import { Media } from "./media.js";
import { Climate } from "./climate.js";
import { Lighting } from "./lighting-page.js";
import { ExtensionCenter } from "./extensions.js";
import { DashboardOverview } from "./dashboard.js";
import { DeveloperTools } from "./developer.js";
import { AreasScreen } from "./areas.js";
import { CommandPalette } from "./palette.js";
import { passkeysSupported, signInWithPasskey } from "./passkeys.js";
import { Icon } from "./icons.js";
import { CanonicalDeviceDetail, DeviceDetailContext } from "./device-detail-router.js";

export type Tab =
  | "dashboard" | "discover" | "devices" | "extensions"
  | "automations" | "scenes" | "rooms" | "areas" | "media" | "climate" | "lighting" | "security" | "energy" | "notifications" | "settings" | "developer";
type NavIcon = "dashboard" | "discover" | "devices" | "extensions" | "automations" | "scenes" | "rooms" | "areas" | "media" | "climate" | "light" | "security" | "energy" | "notifications" | "settings" | "developer";

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
  { id: "climate", label: "Climate", icon: "climate" },
  { id: "lighting", label: "Lighting", icon: "light" },
  { id: "security", label: "Security", icon: "security" },
  { id: "energy", label: "Energy", icon: "energy" },
  { id: "notifications", label: "Notifications", icon: "notifications" },
  { id: "settings", label: "Settings", icon: "settings" },
  { id: "developer", label: "Developer", icon: "developer", dev: true },
];
// On a narrow (phone) bottom bar we surface the everyday five; the rest live behind "More" — a
// visible menu, never hidden functionality.
const PRIMARY: Tab[] = ["dashboard", "rooms", "scenes", "security", "settings"];

/** The persistent labelled rail (§ Design System — Responsive Navigation) appears only at
 * `expanded` density (desktop/laptop/ultrawide/15" panels) — everywhere else, including
 * comfortable-density tablets, gets the same icon tabbar + "More" sheet already proven at
 * every narrower width, so a tablet's modest width never has to share space with a 232px
 * rail. One density read instead of a page-local breakpoint. */
function useWide(): boolean {
  return useAureonDensity() === "expanded";
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
  // The signed-in user's role (§8) — drives which nav destinations and controls are
  // visible, alongside the existing Developer Mode license flag (see NAV filtering below).
  const [role, setRole] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const streamRef = useRef<SupremeStream | null>(null);
  const wide = useWide();
  // Canonical Device Detail (§ Platform Architecture Rule — one detail page per device
  // type, reached identically from every entry point): owned here, at the app root, so no
  // individual page can hold its own "selected device" state and render its own copy.
  const [openDeviceId, setOpenDeviceId] = useState<string | null>(null);
  const [deviceRefreshToken, setDeviceRefreshToken] = useState(0);
  const deviceDetail = { openDevice: setOpenDeviceId, refreshToken: deviceRefreshToken };

  useEffect(() => { void fetchSetupStatus().then(setSetup); }, []);
  // Drop to the login screen only when the refresh token itself is dead (30-day expiry or revoked) —
  // never for a routine access-token rotation, which the SDK already handled silently.
  useEffect(() => onSessionExpired(() => setAuthed(false)), []);
  useEffect(() => {
    if (!authed) return;
    void fetchLicense().then((l) => setDevMode(Boolean(l?.service?.devMode)));
    void client.me().then((m) => setRole(m.user.userType)).catch(() => setRole(null));
  }, [authed]);
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

  const go = (t: Tab) => { if (t === "rooms") setSelectedRoom(null); setOpenDeviceId(null); setTab(t); setMoreOpen(false); };
  // The Developer tab shows for either the home-wide Developer Mode license flag OR an
  // account whose role is specifically "Developer" — either is a legitimate reason to see it.
  const items = NAV.filter((n) => !n.dev || devMode || role === "developer");
  // An Installer-role account sees the same installer-facing diagnostics Developer Mode
  // already reveals in the device list (driver/protocol/IP/MAC) — see devices.tsx.
  const showInstallerDiagnostics = devMode || role === "installer" || role === "developer";
  const palette = paletteOpen ? (
    <CommandPalette
      navItems={items.map((n) => ({ id: n.id, label: n.label }))}
      onNavigate={go}
      onSelectRoom={setSelectedRoom}
      onClose={() => setPaletteOpen(false)}
    />
  ) : null;

  // Keyed on the active tab so switching destinations replays the enter transition (§ Animation).
  // An open canonical device detail REPLACES the tab content entirely, regardless of which
  // tab/room screen requested it — this is what makes it "one destination, reached
  // identically from every path" rather than a per-page overlay.
  const page = openDeviceId ? (
    <div className="page-anim" key={`device:${openDeviceId}`}>
      <CanonicalDeviceDetail
        deviceId={openDeviceId}
        devMode={showInstallerDiagnostics}
        onClose={() => setOpenDeviceId(null)}
        onRemoved={() => { setDeviceRefreshToken((t) => t + 1); setOpenDeviceId(null); }}
      />
    </div>
  ) : (
    <div className="page-anim" key={tab}>
      {tab === "dashboard" && <DashboardOverview onNavigate={go} onOpenRoom={(id) => { setSelectedRoom(id); setTab("rooms"); }} devMode={showInstallerDiagnostics} />}
      {tab === "discover" && <DiscoverDevices />}
      {tab === "devices" && <DeviceManager onNavigate={go} devMode={showInstallerDiagnostics} />}
      {tab === "extensions" && <ExtensionCenter />}
      {tab === "automations" && <Automations />}
      {tab === "scenes" && <Scenes />}
      {tab === "rooms" && <RoomsScreen selected={selectedRoom} onSelect={setSelectedRoom} devMode={showInstallerDiagnostics} />}
      {tab === "areas" && <AreasScreen onNavigate={go} />}
      {tab === "media" && <Media onNavigate={go} devMode={showInstallerDiagnostics} />}
      {tab === "climate" && <Climate onNavigate={go} devMode={showInstallerDiagnostics} />}
      {tab === "lighting" && <Lighting onNavigate={go} devMode={showInstallerDiagnostics} />}
      {tab === "security" && <Security devMode={showInstallerDiagnostics} />}
      {tab === "energy" && <Energy onNavigate={go} />}
      {tab === "notifications" && <div className="page"><NotificationCenter /></div>}
      {tab === "settings" && <ThemeSettings role={role} />}
      {tab === "developer" && (devMode || role === "developer") && <DeveloperTools />}
    </div>
  );

  // Wide (tablet/desktop): a labelled left rail with every destination. Narrow (phone): a floating
  // icon bar of the everyday five + a "More" sheet. Same features, only the layout changes.
  if (wide) {
    return (
      <LiveContext.Provider value={{ states, apply }}>
        <DeviceDetailContext.Provider value={deviceDetail}>
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
        </DeviceDetailContext.Provider>
      </LiveContext.Provider>
    );
  }

  const primary = items.filter((n) => PRIMARY.includes(n.id));
  const overflow = items.filter((n) => !PRIMARY.includes(n.id));
  return (
    <LiveContext.Provider value={{ states, apply }}>
      <DeviceDetailContext.Provider value={deviceDetail}>
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
      </DeviceDetailContext.Provider>
    </LiveContext.Provider>
  );
}

/** A small persistent badge when the hub is in Developer Mode (every feature unlocked). */
function DevWatermark({ show }: { show: boolean }) {
  if (!show) return null;
  return <div className="dev-watermark">DEVELOPMENT BUILD · Developer License</div>;
}

function Login({ onAuthed }: { onAuthed: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
