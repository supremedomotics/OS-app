import { useEffect, useState } from "react";
import { apiRequest } from "./api.js";

/**
 * Pair a phone (§ Security Center). The SupremeOS mobile app signs in by a short-lived pairing code
 * this Hub mints (`POST /v1/pairing/codes`: six digits, ten minutes, single use) and then proves its
 * own key — the code is never a password. Phones already paired are listed here and can be revoked
 * (`/v1/pairing/mobiles`), which is what makes a lost phone stop working.
 */

type Code = { code: string; expiresAt: number };
type Mobile = { mobileId: string; label: string; pairedAt: string; lastSeenAt: string | null; revoked: boolean };

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—");

function errText(body: unknown, fallback: string): string {
  const m = (body as { message?: unknown } | null)?.message;
  return typeof m === "string" && m ? m : fallback;
}

export function PairPhoneSection() {
  const [code, setCode] = useState<Code | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [mobiles, setMobiles] = useState<Mobile[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    const res = await apiRequest("GET", "/v1/pairing/mobiles");
    if (res.status === 200) setMobiles(((res.body as { mobiles?: Mobile[] }).mobiles ?? []).filter((m) => !m.revoked));
    else setMsg({ ok: false, text: errText(res.body, "Could not load paired phones.") });
  }
  useEffect(() => { void load(); }, []);

  // Count down, and drop the code the moment it can no longer be used.
  useEffect(() => {
    if (!code) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [code]);
  const left = code ? Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) : 0;
  useEffect(() => { if (code && left === 0) setCode(null); }, [code, left]);

  async function mint() {
    setBusy("mint"); setMsg(null);
    try {
      const res = await apiRequest("POST", "/v1/pairing/codes");
      const b = res.body as { code?: string; expiresInMs?: number };
      if (res.status !== 200 || !b.code) throw new Error(errText(res.body, "Could not create a pairing code."));
      setNow(Date.now());
      setCode({ code: b.code, expiresAt: Date.now() + (b.expiresInMs ?? 10 * 60_000) });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not create a pairing code." });
    } finally {
      setBusy(null);
    }
  }

  async function revoke(m: Mobile) {
    if (!window.confirm(`Remove “${m.label}”? That phone will be signed out and must be paired again.`)) return;
    setBusy(m.mobileId); setMsg(null);
    try {
      const res = await apiRequest("POST", `/v1/pairing/mobiles/${encodeURIComponent(m.mobileId)}/revoke`);
      if (res.status !== 200) throw new Error(errText(res.body, "Could not remove that phone."));
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not remove that phone." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card-section" style={{ marginTop: 18 }} aria-labelledby="pair-phone-h">
      <h3 id="pair-phone-h" className="section">Pair a phone</h3>
      <p className="muted" style={{ marginTop: -4 }}>
        In the SupremeOS app choose Sign in, then enter the code below. A code works once and lasts ten minutes.
      </p>

      {code ? (
        <div role="status" aria-live="polite" style={{ margin: "12px 0" }}>
          <div
            aria-label={`Pairing code ${code.code.split("").join(" ")}`}
            style={{ fontSize: 40, letterSpacing: "0.28em", fontVariantNumeric: "tabular-nums", fontWeight: 300 }}
          >
            {code.code}
          </div>
          <div className="muted">
            Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
          </div>
          <button onClick={mint} disabled={busy === "mint"} style={{ marginTop: 10 }}>New code</button>
        </div>
      ) : (
        <button onClick={mint} disabled={busy === "mint"}>{busy === "mint" ? "Creating…" : "Show a pairing code"}</button>
      )}

      {msg && <p className={msg.ok ? "muted" : "err"}>{msg.text}</p>}

      <h4 className="section" style={{ marginTop: 18 }}>Paired phones</h4>
      {mobiles === null && <p className="muted">Loading…</p>}
      {mobiles && mobiles.length === 0 && <p className="muted">No phone is paired yet.</p>}
      <div className="sess-list">
        {(mobiles ?? []).map((m) => (
          <div key={m.mobileId} className="sess-row">
            <span className="sess-ic">📱</span>
            <span className="sess-meta">
              <span className="sess-name">{m.label}</span>
              <span className="sess-sub">paired {fmt(m.pairedAt)}{m.lastSeenAt ? ` · last seen ${fmt(m.lastSeenAt)}` : ""}</span>
            </span>
            <button className="danger" disabled={busy === m.mobileId} onClick={() => revoke(m)}>{busy === m.mobileId ? "…" : "Remove"}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
