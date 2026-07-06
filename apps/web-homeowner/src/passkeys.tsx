import { useEffect, useState } from "react";
import { client } from "./api.js";

/**
 * Passkeys / WebAuthn (§ Security Center). Real navigator.credentials ceremonies against the hub's
 * WebAuthn endpoints: register a platform passkey, list/remove them, and sign in passwordlessly.
 * ES256 only (what platform authenticators use). Requires a secure context (https or localhost).
 */

function b64urlToBuf(s: string): ArrayBuffer {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b.buffer;
}
function bufToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;
}

/** Register a new platform passkey for the signed-in user. */
async function registerPasskey(name: string): Promise<void> {
  const opts = await client.beginPasskeyRegistration();
  const pk = {
    challenge: b64urlToBuf(opts.challenge as string),
    rp: opts.rp as PublicKeyCredentialRpEntity,
    user: {
      id: b64urlToBuf((opts.user as { id: string }).id),
      name: (opts.user as { name: string }).name,
      displayName: (opts.user as { displayName: string }).displayName,
    },
    pubKeyCredParams: opts.pubKeyCredParams as PublicKeyCredentialParameters[],
    authenticatorSelection: opts.authenticatorSelection as AuthenticatorSelectionCriteria,
    timeout: opts.timeout as number,
    excludeCredentials: (opts.excludeCredentials as { id: string; type: "public-key" }[]).map((c) => ({ type: c.type, id: b64urlToBuf(c.id) })),
  } satisfies PublicKeyCredentialCreationOptions;
  const cred = (await navigator.credentials.create({ publicKey: pk })) as PublicKeyCredential | null;
  if (!cred) throw new Error("passkey creation cancelled");
  const resp = cred.response as AuthenticatorAttestationResponse;
  await client.finishPasskeyRegistration({
    name,
    clientDataJSON: bufToB64url(resp.clientDataJSON),
    attestationObject: bufToB64url(resp.attestationObject),
  });
}

/** Passwordless passkey sign-in. Returns true on success. */
export async function signInWithPasskey(): Promise<boolean> {
  const opts = await client.beginPasskeyLogin();
  const cred = (await navigator.credentials.get({
    publicKey: { challenge: b64urlToBuf(opts.challenge), rpId: opts.rpId, timeout: opts.timeout, userVerification: "preferred" },
  })) as PublicKeyCredential | null;
  if (!cred) return false;
  const resp = cred.response as AuthenticatorAssertionResponse;
  const res = await client.finishPasskeyLogin({
    credentialId: bufToB64url(cred.rawId),
    clientDataJSON: bufToB64url(resp.clientDataJSON),
    authenticatorData: bufToB64url(resp.authenticatorData),
    signature: bufToB64url(resp.signature),
  });
  return res.status === "ok";
}

type Passkey = { id: string; name: string; createdAt: string; lastUsedAt: string | null };

export function PasskeysSection() {
  const [list, setList] = useState<Passkey[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() { try { setList((await client.passkeys()).passkeys); } catch { /* keep */ } }
  useEffect(() => { void load(); }, []);

  async function add() {
    setBusy(true); setMsg(null);
    try { await registerPasskey(name.trim() || "Passkey"); setName(""); await load(); setMsg({ ok: true, text: "Passkey added." }); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Could not add passkey." }); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    setBusy(true);
    try { await client.removePasskey(id); await load(); } finally { setBusy(false); }
  }

  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString([], { dateStyle: "medium" }) : "never");
  if (!passkeysSupported()) {
    return (
      <div className="sec-block">
        <p className="opt-label">Passkeys</p>
        <p className="muted">This browser doesn’t support passkeys, or the page isn’t on a secure (https) origin.</p>
      </div>
    );
  }
  return (
    <div className="sec-block">
      <p className="opt-label">Passkeys</p>
      <p className="muted">Sign in with your device’s biometrics instead of a password.</p>
      <div className="sess-list" style={{ marginTop: 8 }}>
        {(list ?? []).map((p) => (
          <div key={p.id} className="sess-row">
            <span className="sess-ic">🔐</span>
            <span className="sess-meta">
              <span className="sess-name">{p.name}</span>
              <span className="sess-sub">added {fmt(p.createdAt)} · last used {fmt(p.lastUsedAt)}</span>
            </span>
            <button className="danger" disabled={busy} onClick={() => remove(p.id)}>Remove</button>
          </div>
        ))}
      </div>
      <div className="dev-row2" style={{ marginTop: 8 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Passkey name (e.g. iPhone)" />
        <button className="primary" disabled={busy} onClick={add}>{busy ? "…" : "Add passkey"}</button>
      </div>
      {msg && <p className={msg.ok ? "muted" : "err"} style={{ marginTop: 6 }}>{msg.text}</p>}
    </div>
  );
}
