import { useState } from "react";
import { client, completeSetup, forgotPassword, resetPassword, type SetupStatus } from "./api.js";
import { PasswordInput } from "./password-input.js";

/**
 * First-run Setup Wizard — creates the Supreme OS administrator (Home Assistant is never
 * shown). Mirrors the spec flow: Welcome → Administrator → System → Finish. On finish it
 * signs the new admin straight in.
 */
export function SetupWizard({ status, onDone }: { status: SetupStatus; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [systemName, setSystemName] = useState(status.systemName || "");
  const [location, setLocation] = useState("");
  const [timeZone, setTimeZone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const adminValid = username.trim().length >= 3 && password.length >= 8 && password === confirm;

  async function finish() {
    setError(null);
    setBusy(true);
    try {
      await completeSetup({ username: username.trim(), password, confirmPassword: confirm, systemName, location, timeZone });
      // Land logged in: authenticate through the SDK with the just-created credentials.
      const email = username.includes("@") ? username.trim() : `${username.trim()}@supreme.local`;
      const res = await client.login(email, password);
      if (res.status === "ok") onDone();
      else setError("Account created. Please sign in.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Setup failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login onboarding">
      <h1>Supreme</h1>
      {step === 0 && (
        <>
          <h2>Welcome to Supreme OS</h2>
          <p className="muted">Let's set up your home. This takes less than a minute.</p>
          <button className="primary" onClick={() => setStep(1)}>
            Get started
          </button>
        </>
      )}

      {step === 1 && (
        <>
          <h2>Create administrator</h2>
          <p className="muted">This is the owner account for your home.</p>
          <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          <PasswordInput placeholder="Password (min 8 characters)" value={password} onChange={setPassword} />
          <PasswordInput placeholder="Confirm password" value={confirm} onChange={setConfirm} />
          {confirm.length > 0 && password !== confirm && <p className="err">Passwords don't match.</p>}
          <div className="row">
            <button onClick={() => setStep(0)}>Back</button>
            <button className="primary" disabled={!adminValid} onClick={() => setStep(2)}>
              Continue
            </button>
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <h2>Your home</h2>
          <input placeholder="System name (e.g. The Penthouse)" value={systemName} onChange={(e) => setSystemName(e.target.value)} autoFocus />
          <input placeholder="Location (optional)" value={location} onChange={(e) => setLocation(e.target.value)} />
          <input placeholder="Time zone" value={timeZone} onChange={(e) => setTimeZone(e.target.value)} />
          {error && <p className="err">{error}</p>}
          <div className="row">
            <button onClick={() => setStep(1)}>Back</button>
            <button className="primary" disabled={busy || !systemName.trim()} onClick={finish}>
              {busy ? "Finishing…" : "Finish"}
            </button>
          </div>
        </>
      )}

      <ol className="steps" aria-hidden>
        {[0, 1, 2].map((i) => (
          <li key={i} className={i === step ? "on" : ""} />
        ))}
      </ol>
    </div>
  );
}

/**
 * Forgot-password flow — Supreme-only account recovery. Requests a reset, then (on a
 * local hub, which returns the token) lets the user set a new password inline.
 */
export function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [stage, setStage] = useState<"request" | "reset" | "done">("request");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function request() {
    setError(null);
    setBusy(true);
    try {
      const { resetToken } = await forgotPassword(email.trim());
      if (resetToken) {
        setToken(resetToken);
        setNote("Reset code generated. Choose a new password below.");
      } else {
        setNote("If that account exists, a reset has been sent. Enter the code to continue.");
      }
      setStage("reset");
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setError(null);
    setBusy(true);
    try {
      await resetPassword(token.trim(), newPassword);
      setStage("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <h1>Supreme</h1>
      <h2>Reset password</h2>
      {stage === "request" && (
        <>
          <p className="muted">Enter your account email and we'll start a reset.</p>
          <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          <button className="primary" disabled={busy || !email.trim()} onClick={request}>
            {busy ? "Working…" : "Continue"}
          </button>
        </>
      )}
      {stage === "reset" && (
        <>
          {note && <p className="muted">{note}</p>}
          <input placeholder="Reset code" value={token} onChange={(e) => setToken(e.target.value)} />
          <PasswordInput placeholder="New password (min 8 characters)" value={newPassword} onChange={setNewPassword} />
          {error && <p className="err">{error}</p>}
          <button className="primary" disabled={busy || !token.trim() || newPassword.length < 8} onClick={reset}>
            {busy ? "Resetting…" : "Set new password"}
          </button>
        </>
      )}
      {stage === "done" && <p className="muted">Your password has been reset. You can sign in now.</p>}
      <button className="link" onClick={onBack}>
        ← Back to sign in
      </button>
    </div>
  );
}
