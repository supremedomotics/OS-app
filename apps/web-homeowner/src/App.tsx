import { useEffect, useRef, useState } from "react";
import type { SupremeStream } from "@supreme/sdk";
import { client, openStream } from "./api.js";
import { LiveContext, type LiveStates } from "./live.js";
import { Dashboard, Energy, RoomsScreen, Scenes, Security } from "./screens.js";

type Tab = "home" | "rooms" | "scenes" | "security" | "energy";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "home", label: "Home", icon: "⌂" },
  { id: "rooms", label: "Rooms", icon: "▦" },
  { id: "scenes", label: "Scenes", icon: "✦" },
  { id: "security", label: "Security", icon: "🛡" },
  { id: "energy", label: "Energy", icon: "⚡" },
];

export function App() {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<Tab>("home");
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [states, setStates] = useState<LiveStates>({});
  const streamRef = useRef<SupremeStream | null>(null);

  const apply = (deviceId: string, capability: string, state: unknown) =>
    setStates((s) => ({ ...s, [deviceId]: { ...s[deviceId], [capability]: state } }));

  useEffect(() => {
    if (!authed) return;
    const stream = openStream();
    if (!stream) return;
    streamRef.current = stream;
    stream.connect({
      onOpen: () => stream.subscribe(["*"]),
      onState: (f) => apply(f.deviceId, f.state.kind, f.state),
    });
    return () => stream.close();
  }, [authed]);

  if (!authed) return <Login onAuthed={() => setAuthed(true)} />;

  const openRoom = (roomId: string) => {
    setSelectedRoom(roomId);
    setTab("rooms");
  };

  return (
    <LiveContext.Provider value={{ states, apply }}>
      <div className="shell">
        <div className="content">
          {tab === "home" && <Dashboard onOpenRoom={openRoom} />}
          {tab === "rooms" && (
            <RoomsScreen selected={selectedRoom} onSelect={setSelectedRoom} />
          )}
          {tab === "scenes" && <Scenes />}
          {tab === "security" && <Security />}
          {tab === "energy" && <Energy />}
        </div>
        <nav className="tabbar">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={t.id === tab ? "active" : ""}
              onClick={() => {
                if (t.id === "rooms") setSelectedRoom(null);
                setTab(t.id);
              }}
            >
              <span className="ic">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </nav>
      </div>
    </LiveContext.Provider>
  );
}

function Login({ onAuthed }: { onAuthed: () => void }) {
  const [email, setEmail] = useState("owner@supreme.local");
  const [password, setPassword] = useState("supreme-owner-demo-pass");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await client.login(email, password);
      if (res.status === "ok") onAuthed();
      else setError("Two-factor authentication required");
    } catch {
      setError("Could not sign in. Check your details.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <h1>Supreme</h1>
      <p className="muted">Welcome home.</p>
      <form onSubmit={submit}>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
        />
        {error && <p className="err">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
