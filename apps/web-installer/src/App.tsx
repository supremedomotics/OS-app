import { useState } from "react";
import {
  AUREON_ACCENTS,
  AUREON_MODES,
  applyAureonTheme,
  loadAureonTheme,
  saveAureonTheme,
} from "@supreme/aureon-web";
import { client } from "./api.js";
import { PasswordInput } from "./password-input.js";
import {
  BackupRestore,
  Bindings,
  Cameras,
  Commissioning,
  Dealer,
  Devices,
  Diagnostics,
  DriverStore,
  Fleet,
  Licensing,
  Migration,
} from "./pages.js";

type Tab =
  | "drivers"
  | "commission"
  | "devices"
  | "bindings"
  | "cameras"
  | "diagnostics"
  | "backup"
  | "license"
  | "dealer"
  | "migration"
  | "fleet";

// Discover-first (§ Installer Experience): the installer's first action is scanning for devices —
// the required driver installs automatically on commission — so "Discover Devices" leads. The
// Driver Store moves lower; it's a catalog to browse, not the starting point.
const TABS: { id: Tab; label: string }[] = [
  { id: "commission", label: "Discover Devices" },
  { id: "devices", label: "Devices" },
  { id: "drivers", label: "Driver Store" },
  { id: "bindings", label: "Bus Binding" },
  { id: "cameras", label: "Cameras" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "backup", label: "Backup / Restore" },
  { id: "license", label: "Licensing" },
  { id: "dealer", label: "Dealer Portal" },
  { id: "migration", label: "Native Migration" },
  { id: "fleet", label: "Fleet" },
];

export function App() {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<Tab>("commission");

  if (!authed) return <Login onAuthed={() => setAuthed(true)} />;

  return (
    <div className="app">
      <nav>
        <h1>Supreme · Installer</h1>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={t.id === tab ? "active" : ""}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <ThemeBar />
      </nav>
      <main>
        {tab === "drivers" && <DriverStore />}
        {tab === "commission" && <Commissioning />}
        {tab === "devices" && <Devices />}
        {tab === "bindings" && <Bindings />}
        {tab === "cameras" && <Cameras />}
        {tab === "diagnostics" && <Diagnostics />}
        {tab === "backup" && <BackupRestore />}
        {tab === "license" && <Licensing />}
        {tab === "dealer" && <Dealer />}
        {tab === "migration" && <Migration />}
        {tab === "fleet" && <Fleet />}
      </main>
    </div>
  );
}

/** Compact appearance control in the installer sidebar (§11.2 Themes). */
function ThemeBar() {
  const [choice, setChoice] = useState(loadAureonTheme());
  const set = (next: Partial<typeof choice>) => {
    const merged = { ...choice, ...next };
    setChoice(merged);
    applyAureonTheme(merged);
    saveAureonTheme(merged);
  };
  return (
    <div className="theme-bar">
      <span className="theme-bar-label">Appearance</span>
      <div className="theme-bar-row">
        {AUREON_MODES.map((m) => (
          <button key={m.key} className={choice.mode === m.key ? "active" : ""} onClick={() => set({ mode: m.key })}>
            {m.label.replace("Luxury ", "")}
          </button>
        ))}
      </div>
      <div className="theme-bar-row">
        {AUREON_ACCENTS.map((a) => (
          <button key={a.key} className={choice.accent === a.key ? "active" : ""} onClick={() => set({ accent: a.key })}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Login({ onAuthed }: { onAuthed: () => void }) {
  const [email, setEmail] = useState("owner@supreme.local");
  const [password, setPassword] = useState("supreme-owner-demo-pass");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await client.login(email, password);
      if (res.status === "ok") onAuthed();
      else setError("Two-factor authentication required");
    } catch {
      setError("Sign in failed");
    }
  }

  return (
    <main style={{ maxWidth: 360, margin: "10vh auto" }}>
      <h1 style={{ color: "var(--aureon-color-gold-400)" }}>Supreme Installer</h1>
      <form onSubmit={submit}>
        <div className="card">
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
          <PasswordInput value={password} onChange={setPassword} placeholder="Password" style={{ marginTop: 8 }} />
        </div>
        {error && <p style={{ color: "var(--aureon-color-status-critical)" }}>{error}</p>}
        <button className="primary" type="submit">Sign in</button>
      </form>
    </main>
  );
}
