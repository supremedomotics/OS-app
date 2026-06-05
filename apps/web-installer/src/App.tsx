import { useState } from "react";
import { client } from "./api.js";
import {
  BackupRestore,
  Commissioning,
  Diagnostics,
  DriverStore,
  Fleet,
  Licensing,
  Migration,
} from "./pages.js";

type Tab =
  | "drivers"
  | "commission"
  | "diagnostics"
  | "backup"
  | "license"
  | "migration"
  | "fleet";

const TABS: { id: Tab; label: string }[] = [
  { id: "drivers", label: "Driver Store" },
  { id: "commission", label: "Commissioning" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "backup", label: "Backup / Restore" },
  { id: "license", label: "Licensing" },
  { id: "migration", label: "Native Migration" },
  { id: "fleet", label: "Fleet" },
];

export function App() {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<Tab>("drivers");

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
      </nav>
      <main>
        {tab === "drivers" && <DriverStore />}
        {tab === "commission" && <Commissioning />}
        {tab === "diagnostics" && <Diagnostics />}
        {tab === "backup" && <BackupRestore />}
        {tab === "license" && <Licensing />}
        {tab === "migration" && <Migration />}
        {tab === "fleet" && <Fleet />}
      </main>
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
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            style={{ marginTop: 8 }}
          />
        </div>
        {error && <p style={{ color: "var(--aureon-color-status-critical)" }}>{error}</p>}
        <button className="primary" type="submit">Sign in</button>
      </form>
    </main>
  );
}
