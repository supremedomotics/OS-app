import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import {
  newId,
  type Home,
  type HomeId,
  type User,
  type UserId,
  type UserType,
} from "@supreme/domain-model";
import { SupremeError, type LoginResponse, type TokenPair } from "@supreme/contracts";
import {
  InMemoryApiTokenStore,
  InMemoryIdentityStore,
  InMemorySessionStore,
  InMemoryWebAuthnStore,
  type ApiTokenRecordMeta,
  type IApiTokenStore,
  type IIdentityStore,
  type ISessionStore,
  type IWebAuthnStore,
  type Session,
  type WebAuthnCredentialMeta,
} from "./store.js";
import { newChallenge, verifyAuthentication, verifyRegistration } from "./webauthn.js";
import { TokenService } from "./tokens.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "./totp.js";
import { checkPassword, DEFAULT_PASSWORD_POLICY, type PasswordPolicy } from "./password-policy.js";

/** Where a login came from — captured onto the session for the Security Center. */
export interface LoginContext {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Supreme identity service (§8, §12).
 *
 * Owns the Supreme user model — HA users do NOT exist here. The first
 * commissioning user becomes the Master User. Passwords use Argon2id; login can
 * require TOTP MFA before tokens are issued. All of this runs on the hub and
 * validates offline.
 */
export interface IdentityServiceOptions {
  tokenSecret: string;
  store?: IIdentityStore;
  sessionStore?: ISessionStore;
  /** Personal API-token store (§ Security Center). */
  apiTokenStore?: IApiTokenStore;
  /** Passkey / WebAuthn credential store (§ Security Center). */
  webAuthnStore?: IWebAuthnStore;
  /** Relying-Party id + expected origin for WebAuthn (defaults to localhost/dev). */
  webAuthn?: { rpId: string; rpName: string; origin?: string };
  /** Password policy (§ password policies); defaults to {@link DEFAULT_PASSWORD_POLICY}. */
  passwordPolicy?: PasswordPolicy;
  /** Consecutive failed logins before an account is temporarily locked (§ brute-force). Default 5. */
  maxLoginAttempts?: number;
  /** Lockout window in ms once the threshold is hit. Default 15 minutes. */
  lockoutMs?: number;
}

// OWASP-recommended Argon2id parameters.
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export class IdentityService {
  private readonly store: IIdentityStore;
  private readonly sessions: ISessionStore;
  private readonly apiTokens: IApiTokenStore;
  private readonly webAuthnStore: IWebAuthnStore;
  private readonly rp: { rpId: string; rpName: string; origin?: string };
  /** Pending WebAuthn challenges: registration keyed by userId, authentication keyed by challenge. */
  private readonly regChallenges = new Map<UserId, { challenge: string; expiresAt: number }>();
  private readonly authChallenges = new Map<string, number>();
  /** Pending (un-activated) TOTP secrets during enrollment, keyed by user. */
  private readonly pendingMfa = new Map<UserId, string>();
  readonly tokens: TokenService;
  readonly passwordPolicy: PasswordPolicy;
  private readonly maxLoginAttempts: number;
  private readonly lockoutMs: number;
  /** Brute-force tracker keyed by login identifier → failed count + lock expiry (ms). In-memory: a
   * hub restart clears locks, which is the safe/conservative direction. */
  private readonly loginFailures = new Map<string, { count: number; lockedUntil: number }>();

  constructor(opts: IdentityServiceOptions) {
    this.store = opts.store ?? new InMemoryIdentityStore();
    this.sessions = opts.sessionStore ?? new InMemorySessionStore();
    this.apiTokens = opts.apiTokenStore ?? new InMemoryApiTokenStore();
    this.webAuthnStore = opts.webAuthnStore ?? new InMemoryWebAuthnStore();
    this.rp = opts.webAuthn ?? { rpId: "localhost", rpName: "Supreme OS" };
    this.tokens = new TokenService({ secret: opts.tokenSecret });
    this.passwordPolicy = opts.passwordPolicy ?? DEFAULT_PASSWORD_POLICY;
    this.maxLoginAttempts = opts.maxLoginAttempts ?? 5;
    this.lockoutMs = opts.lockoutMs ?? 15 * 60_000;
  }

  /** Enforce the configured password policy; throws a validation error on a weak/compromised choice. */
  private enforcePasswordPolicy(password: string): void {
    const res = checkPassword(password, this.passwordPolicy);
    if (!res.ok) throw new SupremeError("validation_failed", res.reason ?? "password does not meet the policy");
  }

  /** Record a failed login and lock the identifier once the threshold is reached. */
  private recordLoginFailure(key: string, nowMs: number): void {
    const rec = this.loginFailures.get(key) ?? { count: 0, lockedUntil: 0 };
    rec.count += 1;
    if (rec.count >= this.maxLoginAttempts) rec.lockedUntil = nowMs + this.lockoutMs;
    this.loginFailures.set(key, rec);
  }

  /**
   * Commission the home: creates the home and its Master User. Idempotent-guarded —
   * a second call throws so commissioning can only happen once.
   */
  async commission(input: {
    homeName: string;
    email: string;
    password: string;
    displayName: string;
  }): Promise<{ home: Home; master: User }> {
    if (await this.store.getHome()) {
      throw new SupremeError("conflict", "home is already commissioned");
    }
    this.enforcePasswordPolicy(input.password);
    const homeId = newId("home") as HomeId;
    const userId = newId("user") as UserId;
    const now = new Date().toISOString();

    const master: User = {
      id: userId,
      homeId,
      email: input.email,
      phone: null,
      displayName: input.displayName,
      userType: "master",
      status: "active",
      // The master commissions the home in person, so their email starts verified.
      emailVerified: true,
      createdAt: now,
      expiresAt: null,
    };
    const home: Home = {
      id: homeId,
      name: input.homeName,
      address: null,
      tier: "signature",
      masterUserId: userId,
      createdAt: now,
    };

    await this.store.putHome(home);
    await this.store.putUser(master);
    await this.store.putCredential({
      userId,
      passwordHash: await hash(input.password, ARGON2),
      mfaSecret: null,
    });
    return { home, master };
  }

  /** Add a user (family/guest/staff/installer/…). Caller enforces authorization. */
  async createUser(input: {
    email: string;
    password: string;
    displayName: string;
    userType: UserType;
    expiresAt?: string | null;
  }): Promise<User> {
    const home = await this.requireHome();
    this.enforcePasswordPolicy(input.password);
    if (await this.store.findUserByEmail(input.email)) {
      throw new SupremeError("conflict", "a user with that email already exists");
    }
    const user: User = {
      id: newId("user") as UserId,
      homeId: home.id,
      email: input.email,
      phone: null,
      displayName: input.displayName,
      userType: input.userType,
      status: "active",
      // Invited users must verify their email (§ email verification).
      emailVerified: false,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt ?? null,
    };
    await this.store.putUser(user);
    await this.store.putCredential({
      userId: user.id,
      passwordHash: await hash(input.password, ARGON2),
      mfaSecret: null,
    });
    return user;
  }

  async login(email: string, password: string, context: LoginContext = {}): Promise<LoginResponse> {
    // Brute-force lockout (§ Authentication): after too many consecutive failures the identifier is
    // locked for a cooldown, whether or not the account exists (also blunts enumeration).
    const key = email.trim().toLowerCase();
    const nowMs = Date.now();
    const lock = this.loginFailures.get(key);
    if (lock && lock.lockedUntil > nowMs) {
      const mins = Math.ceil((lock.lockedUntil - nowMs) / 60_000);
      throw new SupremeError("forbidden", `too many failed attempts — try again in ${mins} minute${mins === 1 ? "" : "s"}`);
    }

    const user = await this.store.findUserByEmail(email);
    const cred = user ? await this.store.getCredential(user.id) : null;

    // Always run a verification to keep timing uniform whether or not the user exists.
    const ok = cred ? await verify(cred.passwordHash, password).catch(() => false) : await dummyVerify(password);
    if (!user || !cred || !ok) {
      this.recordLoginFailure(key, nowMs);
      throw new SupremeError("unauthorized", "invalid email or password");
    }
    if (user.status !== "active") {
      throw new SupremeError("forbidden", `account is ${user.status}`);
    }
    // Success → clear the failure counter for this identifier.
    this.loginFailures.delete(key);

    const base = { sub: user.id, homeId: user.homeId, userType: user.userType };
    if (cred.mfaSecret) {
      return { status: "mfa_required", mfaToken: await this.tokens.issueMfa(base) };
    }
    // New login → new revocable session, with the first refresh jti in the chain.
    const { sid, jti } = await this.openSession(user.id, context);
    return { status: "ok", ...(await this.issueTokens(user, sid, jti)) };
  }

  /** Create a fresh revocable session, capturing where the login came from (§ Security Center). */
  private async openSession(userId: UserId, context: LoginContext): Promise<{ sid: string; jti: string }> {
    const sid = newId("session") as string;
    const jti = newId("session") as string;
    const now = new Date().toISOString();
    await this.sessions.create({
      id: sid,
      userId,
      currentJti: jti,
      revoked: false,
      createdAt: now,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      lastSeenAt: now,
    });
    return { sid, jti };
  }

  /** A user's sessions (active + revoked), newest first — the login history / trusted devices. */
  listSessions(userId: UserId): Promise<Session[]> {
    return this.sessions.listByUser(userId);
  }

  /** Revoke one of the user's own sessions (remote logout). Ownership is enforced. */
  async revokeSession(userId: UserId, sessionId: string): Promise<void> {
    const session = await this.sessions.get(sessionId);
    if (!session || session.userId !== userId) {
      throw new SupremeError("not_found", "session not found");
    }
    await this.sessions.revoke(sessionId);
  }

  /** Sign out everywhere except the caller's current session. Returns how many were revoked. */
  async revokeOtherSessions(userId: UserId, keepSessionId: string): Promise<number> {
    const sessions = await this.sessions.listByUser(userId);
    let revoked = 0;
    for (const s of sessions) {
      if (s.id !== keepSessionId && !s.revoked) {
        await this.sessions.revoke(s.id);
        revoked += 1;
      }
    }
    return revoked;
  }

  /**
   * Rotate the refresh token (§12). The presented refresh token must be the CURRENT
   * one in its session's chain; presenting an older (already-rotated) token is reuse
   * — we revoke the entire session so a stolen token can't be replayed.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const claims = await this.tokens.verify(refreshToken, "refresh");
    const user = await this.store.getUser(claims.sub);
    if (!user || user.status !== "active") {
      throw new SupremeError("unauthorized", "session is no longer valid");
    }
    if (!claims.sid || !claims.jti) {
      throw new SupremeError("unauthorized", "refresh token is not session-bound");
    }
    const session = await this.sessions.get(claims.sid);
    if (!session || session.revoked) {
      throw new SupremeError("unauthorized", "session has been revoked");
    }
    if (session.currentJti !== claims.jti) {
      // Reuse of a rotated token → assume compromise; revoke the session.
      await this.sessions.revoke(claims.sid);
      throw new SupremeError("unauthorized", "refresh token reuse detected; session revoked");
    }
    const nextJti = newId("session") as string;
    // Compare-and-swap: only rotate if currentJti is still exactly claims.jti (what we just read
    // above). Two concurrent refresh() calls for the same session (two tabs, a double-mount) can
    // both pass the `session.currentJti !== claims.jti` check above before either writes — without
    // a CAS here, the loser's write would silently clobber the winner's, and the loser's stale
    // nextJti would then look like reuse on a LATER refresh and spuriously revoke the session.
    const rotated = await this.sessions.setCurrentJti(claims.sid, claims.jti, nextJti);
    if (!rotated) {
      // We already confirmed (above) that session.currentJti === claims.jti at read time, so the
      // only way the swap can fail now is a concurrent refresh() winning the race in between —
      // this is NOT reuse (that's already caught by the check above on the *next* attempt with a
      // stale jti). Treat it as benign: hand back valid tokens bound to whatever is current now,
      // rather than revoking a session that's still perfectly legitimate.
      const latest = await this.sessions.get(claims.sid);
      if (!latest || latest.revoked) {
        throw new SupremeError("unauthorized", "session has been revoked");
      }
      await this.sessions.touch(claims.sid, new Date().toISOString());
      return this.issueTokens(user, claims.sid, latest.currentJti);
    }
    await this.sessions.touch(claims.sid, new Date().toISOString());
    return this.issueTokens(user, claims.sid, nextJti);
  }

  /**
   * Complete an MFA-gated login: verify the 6-digit TOTP against the short-lived
   * mfa token issued by {@link login}, then issue access/refresh tokens.
   */
  async verifyMfaLogin(mfaToken: string, code: string, context: LoginContext = {}): Promise<TokenPair> {
    const claims = await this.tokens.verify(mfaToken, "mfa");
    const user = await this.store.getUser(claims.sub);
    if (!user || user.status !== "active") {
      throw new SupremeError("unauthorized", "session is no longer valid");
    }
    const cred = await this.store.getCredential(user.id);
    if (!cred?.mfaSecret) {
      throw new SupremeError("unauthorized", "invalid authentication code");
    }
    // Accept a TOTP code OR a one-time recovery code (consumed on use).
    const normalized = code.replace(/\s+/g, "");
    if (!verifyTotp(cred.mfaSecret, normalized)) {
      const codeHash = sha256(normalized.toLowerCase());
      const remaining = cred.recoveryCodes ?? [];
      if (!remaining.includes(codeHash)) {
        throw new SupremeError("unauthorized", "invalid authentication code");
      }
      await this.store.putCredential({ ...cred, recoveryCodes: remaining.filter((h) => h !== codeHash) });
    }
    const { sid, jti } = await this.openSession(user.id, context);
    return this.issueTokens(user, sid, jti);
  }

  /**
   * Generate a fresh set of one-time MFA recovery codes (§ Security Center). Requires MFA to be
   * enabled; returns the plaintext codes ONCE (only hashes are stored) and replaces any prior set.
   */
  async regenerateRecoveryCodes(userId: UserId, count = 10): Promise<string[]> {
    const cred = await this.store.getCredential(userId);
    if (!cred) throw new SupremeError("not_found", "credential not found");
    if (!cred.mfaSecret) throw new SupremeError("conflict", "enable two-factor authentication first");
    const codes = Array.from({ length: count }, () => formatRecoveryCode(randomBytes(5)));
    await this.store.putCredential({ ...cred, recoveryCodes: codes.map((c) => sha256(c.toLowerCase())) });
    return codes;
  }

  /** Recovery-code status for a user: whether MFA is on + how many unused codes remain. */
  async recoveryCodeStatus(userId: UserId): Promise<{ mfaEnabled: boolean; remaining: number }> {
    const cred = await this.store.getCredential(userId);
    return { mfaEnabled: Boolean(cred?.mfaSecret), remaining: cred?.recoveryCodes?.length ?? 0 };
  }

  /** Begin TOTP enrollment: returns the secret + otpauth URL to show as a QR code. */
  async startMfaEnrollment(userId: UserId): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.getUser(userId);
    const secret = generateTotpSecret();
    this.pendingMfa.set(userId, secret);
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  /** Confirm enrollment by verifying a code against the pending secret; activates MFA. */
  async confirmMfaEnrollment(userId: UserId, code: string): Promise<void> {
    const secret = this.pendingMfa.get(userId);
    if (!secret) throw new SupremeError("conflict", "no pending MFA enrollment");
    if (!verifyTotp(secret, code)) throw new SupremeError("unauthorized", "invalid authentication code");
    const cred = await this.store.getCredential(userId);
    if (!cred) throw new SupremeError("not_found", "credential not found");
    await this.store.putCredential({ ...cred, mfaSecret: secret });
    this.pendingMfa.delete(userId);
  }

  /** Disable MFA after verifying a current code. */
  async disableMfa(userId: UserId, code: string): Promise<void> {
    const cred = await this.store.getCredential(userId);
    if (!cred?.mfaSecret) return;
    if (!verifyTotp(cred.mfaSecret, code)) throw new SupremeError("unauthorized", "invalid authentication code");
    // Disabling MFA also invalidates any outstanding recovery codes.
    await this.store.putCredential({ ...cred, mfaSecret: null, recoveryCodes: [] });
  }

  /** Whether a user has MFA enabled. */
  async hasMfa(userId: UserId): Promise<boolean> {
    return Boolean((await this.store.getCredential(userId))?.mfaSecret);
  }

  // ── Password reset (§ forgot-password) — Supreme-only, never touches HA ─────────
  /** One-time reset tokens keyed by their SHA-256 (we never store the raw token). */
  private readonly resetTokens = new Map<string, { userId: UserId; expiresAt: number }>();
  private static readonly RESET_TTL_MS = 30 * 60 * 1000;
  /** Email-verification tokens (hash → {userId, email, expiry}). Bound to the email so changing it
   * invalidates a pending link. */
  private readonly verifyTokens = new Map<string, { userId: UserId; email: string; expiresAt: number }>();
  private static readonly VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

  /**
   * Begin (or resend) email verification for a user. Returns a one-time token the caller delivers
   * out-of-band (email) in production; the local hub surfaces it for LAN self-service — the SAME
   * honest pattern as password reset. A no-op returning null when the email is already verified.
   */
  async requestEmailVerification(userId: UserId): Promise<{ token: string } | null> {
    const user = await this.getUser(userId);
    if (user.emailVerified) return null;
    const token = randomBytes(24).toString("base64url");
    this.verifyTokens.set(sha256(token), {
      userId: user.id,
      email: user.email.toLowerCase(),
      expiresAt: Date.now() + IdentityService.VERIFY_TTL_MS,
    });
    return { token };
  }

  /** Complete verification with a valid, unexpired token; marks the email verified. */
  async verifyEmail(token: string): Promise<User> {
    const key = sha256(token);
    const rec = this.verifyTokens.get(key);
    if (!rec || rec.expiresAt < Date.now()) {
      this.verifyTokens.delete(key);
      throw new SupremeError("unauthorized", "invalid or expired verification token");
    }
    this.verifyTokens.delete(key);
    const user = await this.getUser(rec.userId);
    // If the email changed since the token was issued, the link no longer applies.
    if (user.email.toLowerCase() !== rec.email) {
      throw new SupremeError("conflict", "email has changed since this link was sent");
    }
    if (user.emailVerified) return user;
    const next: User = { ...user, emailVerified: true };
    await this.store.putUser(next);
    return next;
  }

  /**
   * Begin a password reset. Returns a one-time token for the caller to deliver
   * (out-of-band in production; surfaced on the local hub for LAN self-service).
   * Anti-enumeration: returns null silently when the email is unknown.
   */
  async requestPasswordReset(email: string): Promise<{ token: string; userId: UserId } | null> {
    const user = await this.store.findUserByEmail(email);
    if (!user) return null;
    const token = randomBytes(24).toString("base64url");
    this.resetTokens.set(sha256(token), {
      userId: user.id,
      expiresAt: Date.now() + IdentityService.RESET_TTL_MS,
    });
    return { token, userId: user.id };
  }

  /** Complete a reset with a valid, unexpired token. Sets only the Supreme password. */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    this.enforcePasswordPolicy(newPassword);
    const key = sha256(token);
    const rec = this.resetTokens.get(key);
    if (!rec || rec.expiresAt < Date.now()) {
      this.resetTokens.delete(key);
      throw new SupremeError("unauthorized", "invalid or expired reset token");
    }
    this.resetTokens.delete(key);
    const cred = await this.store.getCredential(rec.userId);
    await this.store.putCredential({
      userId: rec.userId,
      passwordHash: await hash(newPassword, ARGON2),
      mfaSecret: cred?.mfaSecret ?? null,
      recoveryCodes: cred?.recoveryCodes ?? [],
    });
  }

  /**
   * Change the password of a signed-in user. Verifies the current password first (so a stolen
   * session can't silently change it), then sets the new Supreme password. Supreme-only — HA is
   * never touched.
   */
  async changePassword(userId: UserId, currentPassword: string, newPassword: string): Promise<void> {
    this.enforcePasswordPolicy(newPassword);
    const cred = await this.store.getCredential(userId);
    const ok = cred ? await verify(cred.passwordHash, currentPassword).catch(() => false) : false;
    if (!cred || !ok) {
      throw new SupremeError("unauthorized", "current password is incorrect");
    }
    await this.store.putCredential({
      userId,
      passwordHash: await hash(newPassword, ARGON2),
      mfaSecret: cred.mfaSecret ?? null,
      recoveryCodes: cred.recoveryCodes ?? [],
    });
  }

  /** Revoke a session from any of its tokens (logout / "sign out everywhere"). */
  async logout(token: string): Promise<void> {
    let sid: string | undefined;
    try {
      sid = (await this.tokens.verify(token, "access")).sid;
    } catch {
      try {
        sid = (await this.tokens.verify(token, "refresh")).sid;
      } catch {
        sid = undefined;
      }
    }
    if (sid) await this.sessions.revoke(sid);
  }

  // ── Personal API tokens (§ Security Center) ──────────────────────────────────

  /** Prefix that marks a Bearer credential as a long-lived personal API token (vs. a JWT). */
  private static readonly API_TOKEN_PREFIX = "sup_pat_";

  /**
   * Create a personal API token for programmatic access. Returns the plaintext ONCE (only the hash
   * is stored) plus its metadata. The token authenticates on every route the user can access.
   */
  async createApiToken(userId: UserId, name: string): Promise<{ token: string; meta: ApiTokenRecordMeta }> {
    const user = await this.getUser(userId);
    const label = name.trim() || "API token";
    const token = `${IdentityService.API_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
    const meta: ApiTokenRecordMeta = {
      id: newId("session") as string,
      homeId: user.homeId,
      userId,
      name: label,
      prefix: token.slice(0, 16),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revoked: false,
    };
    await this.apiTokens.create({ ...meta, tokenHash: sha256(token) });
    return { token, meta };
  }

  listApiTokens(userId: UserId): Promise<ApiTokenRecordMeta[]> {
    return this.apiTokens.listByUser(userId);
  }

  async revokeApiToken(userId: UserId, id: string): Promise<void> {
    const rec = await this.apiTokens.get(userId, id);
    if (!rec) throw new SupremeError("not_found", "API token not found");
    await this.apiTokens.revoke(userId, id);
  }

  /** Resolve a personal API token to its live user (updating last-used), or null if invalid. */
  private async authenticateApiToken(token: string): Promise<User | null> {
    const rec = await this.apiTokens.findByHash(sha256(token));
    if (!rec || rec.revoked) return null;
    const user = await this.store.getUser(rec.userId);
    if (!user || user.status !== "active") return null;
    await this.apiTokens.touch(rec.id, new Date().toISOString());
    return user;
  }

  // ── Passkeys / WebAuthn (§ Security Center) ──────────────────────────────────
  private static readonly WEBAUTHN_TTL_MS = 5 * 60 * 1000;

  listPasskeys(userId: UserId): Promise<WebAuthnCredentialMeta[]> {
    return this.webAuthnStore.listByUser(userId);
  }

  async removePasskey(userId: UserId, id: string): Promise<void> {
    const rec = await this.webAuthnStore.get(userId, id);
    if (!rec) throw new SupremeError("not_found", "passkey not found");
    await this.webAuthnStore.remove(userId, id);
  }

  /** Begin passkey registration — returns the PublicKeyCredentialCreationOptions the browser needs. */
  async beginPasskeyRegistration(userId: UserId): Promise<Record<string, unknown>> {
    const user = await this.getUser(userId);
    const challenge = newChallenge();
    this.regChallenges.set(userId, { challenge, expiresAt: Date.now() + IdentityService.WEBAUTHN_TTL_MS });
    const existing = await this.webAuthnStore.listByUser(userId);
    return {
      challenge,
      rp: { id: this.rp.rpId, name: this.rp.rpName },
      user: { id: Buffer.from(userId).toString("base64url"), name: user.email, displayName: user.displayName },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      excludeCredentials: existing.map((c) => ({ type: "public-key", id: c.credentialId })),
      timeout: 60000,
    };
  }

  /** Finish registration: verify the attestation + store the credential. */
  async finishPasskeyRegistration(userId: UserId, input: { name?: string; clientDataJSON: string; attestationObject: string }): Promise<WebAuthnCredentialMeta> {
    const pending = this.regChallenges.get(userId);
    if (!pending || pending.expiresAt < Date.now()) {
      this.regChallenges.delete(userId);
      throw new SupremeError("unauthorized", "registration challenge expired — try again");
    }
    this.regChallenges.delete(userId);
    let reg;
    try {
      reg = verifyRegistration({ clientDataJSON: input.clientDataJSON, attestationObject: input.attestationObject, expectedChallenge: pending.challenge, expectedOrigin: this.rp.origin });
    } catch (e) {
      throw new SupremeError("validation_failed", e instanceof Error ? e.message : "passkey registration failed");
    }
    const meta: WebAuthnCredentialMeta = {
      id: newId("session") as string,
      userId,
      credentialId: reg.credentialId,
      signCount: reg.signCount,
      name: input.name?.trim() || "Passkey",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    await this.webAuthnStore.create({ ...meta, publicKeyPem: reg.publicKeyPem });
    return meta;
  }

  /** Begin a passkey login — returns the request options (discoverable credentials). */
  beginPasskeyAuthentication(): { challenge: string; rpId: string; timeout: number } {
    const challenge = newChallenge();
    this.authChallenges.set(challenge, Date.now() + IdentityService.WEBAUTHN_TTL_MS);
    return { challenge, rpId: this.rp.rpId, timeout: 60000 };
  }

  /** Finish a passkey login: verify the assertion, then issue tokens (a real, passwordless login). */
  async finishPasskeyAuthentication(input: { credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string }, context: LoginContext = {}): Promise<TokenPair> {
    const cred = await this.webAuthnStore.findByCredentialId(input.credentialId);
    if (!cred) throw new SupremeError("unauthorized", "unknown passkey");
    // The challenge in clientData must be one we issued (and unexpired), then it's single-use.
    const clientData = JSON.parse(Buffer.from(input.clientDataJSON, "base64url").toString("utf8")) as { challenge: string };
    const exp = this.authChallenges.get(clientData.challenge);
    if (!exp || exp < Date.now()) {
      this.authChallenges.delete(clientData.challenge);
      throw new SupremeError("unauthorized", "login challenge expired — try again");
    }
    this.authChallenges.delete(clientData.challenge);

    let result;
    try {
      result = verifyAuthentication({
        clientDataJSON: input.clientDataJSON,
        authenticatorData: input.authenticatorData,
        signature: input.signature,
        publicKeyPem: cred.publicKeyPem,
        expectedChallenge: clientData.challenge,
        expectedOrigin: this.rp.origin,
      });
    } catch (e) {
      throw new SupremeError("unauthorized", e instanceof Error ? e.message : "passkey verification failed");
    }
    const user = await this.store.getUser(cred.userId);
    if (!user || user.status !== "active") throw new SupremeError("unauthorized", "account is not active");
    await this.webAuthnStore.updateSignCount(cred.id, result.signCount, new Date().toISOString());
    const { sid, jti } = await this.openSession(user.id, context);
    return this.issueTokens(user, sid, jti);
  }

  /** Verify an access token and return the live user. Used by the gateway authn. */
  async authenticate(accessToken: string): Promise<User> {
    // A long-lived personal API token authenticates directly (no session/JWT).
    if (accessToken.startsWith(IdentityService.API_TOKEN_PREFIX)) {
      const user = await this.authenticateApiToken(accessToken);
      if (!user) throw new SupremeError("unauthorized", "invalid API token");
      return user;
    }
    const claims = await this.tokens.verify(accessToken, "access");
    const user = await this.store.getUser(claims.sub);
    if (!user || user.status !== "active") {
      throw new SupremeError("unauthorized", "session is no longer valid");
    }
    // Honor revocation: a session-bound access token from a revoked session is rejected.
    if (claims.sid) {
      const session = await this.sessions.get(claims.sid);
      if (!session || session.revoked) {
        throw new SupremeError("unauthorized", "session has been revoked");
      }
    }
    return user;
  }

  /** Like {@link authenticate} but also returns the caller's session id, so routes can flag the
   * current session and support "sign out other sessions". */
  async authenticateSession(accessToken: string): Promise<{ user: User; sid?: string }> {
    const claims = await this.tokens.verify(accessToken, "access");
    const user = await this.authenticate(accessToken);
    return { user, sid: claims.sid };
  }

  listUsers(): Promise<User[]> {
    return this.store.listUsers();
  }

  async getUser(id: UserId): Promise<User> {
    const user = await this.store.getUser(id);
    if (!user) throw new SupremeError("not_found", "user not found");
    return user;
  }

  /**
   * Change a user's email/username after re-authenticating with their current password (§ account
   * self-service). Rejects a duplicate email so logins stay unambiguous.
   */
  async changeEmail(userId: UserId, newEmail: string, currentPassword: string): Promise<User> {
    const user = await this.getUser(userId);
    const cred = await this.store.getCredential(userId);
    const ok = cred ? await verify(cred.passwordHash, currentPassword).catch(() => false) : false;
    if (!cred || !ok) {
      throw new SupremeError("unauthorized", "current password is incorrect");
    }
    const normalized = newEmail.trim();
    const existing = await this.store.findUserByEmail(normalized);
    if (existing && existing.id !== userId) {
      throw new SupremeError("conflict", "a user with that email already exists");
    }
    // A new address is unverified until re-verified (unless unchanged).
    const emailVerified = normalized.toLowerCase() === user.email.toLowerCase() ? user.emailVerified : false;
    const next: User = { ...user, email: normalized, emailVerified };
    await this.store.putUser(next);
    return next;
  }

  /**
   * Permanently delete a user account (admin flow). The master (home owner) can never be deleted —
   * that would orphan the home — so this guards it explicitly.
   */
  async deleteUser(id: UserId): Promise<void> {
    const user = await this.getUser(id);
    if (user.userType === "master") {
      throw new SupremeError("conflict", "the master (owner) account cannot be deleted");
    }
    await this.store.deleteUser(id);
  }

  /** § PASS 22 (Part B, System Reset) — deletes EVERY user including the master account,
   * bypassing {@link deleteUser}'s master-guard. Only for a full system reset (which then
   * flips `ctx.setupRequired` back to true so the Setup Wizard re-provisions a master). */
  async resetAllUsers(): Promise<number> {
    const users = await this.store.listUsers();
    for (const u of users) await this.store.deleteUser(u.id);
    // § PASS 22B — also clear the identity-store's own commissioned-home record, a
    // SEPARATE row from HomeService's home (see AppContext.completeSetup's doc comment).
    // Leaving it behind made `commission()` reject every post-reset re-provisioning
    // attempt with "home is already commissioned", even though every user/device/room
    // had genuinely been wiped.
    await this.store.deleteHome();
    return users.length;
  }

  /** Self-service account deletion — re-authenticate with the current password, then delete. */
  async deleteOwnAccount(userId: UserId, currentPassword: string): Promise<void> {
    const cred = await this.store.getCredential(userId);
    const ok = cred ? await verify(cred.passwordHash, currentPassword).catch(() => false) : false;
    if (!cred || !ok) {
      throw new SupremeError("unauthorized", "current password is incorrect");
    }
    await this.deleteUser(userId); // reuses the master-account guard
  }

  /** Suspend, reactivate, or expire a user (master/admin flow, §8). */
  async setUserStatus(id: UserId, status: "active" | "suspended" | "expired"): Promise<User> {
    const user = await this.getUser(id);
    if (user.userType === "master" && status !== "active") {
      throw new SupremeError("conflict", "the master user cannot be suspended or expired");
    }
    const next: User = { ...user, status };
    await this.store.putUser(next);
    return next;
  }

  /**
   * Change a user's role (master/admin flow, §8) — whether they sign in as an Installer,
   * a Developer, a Homeowner, etc. The master (home owner) account can never be
   * re-typed away from "master" (there must always be exactly one, set at
   * commissioning), and no other account can be promoted TO "master" through this path.
   */
  async updateUserRole(id: UserId, userType: UserType): Promise<User> {
    const user = await this.getUser(id);
    if (user.userType === "master") {
      throw new SupremeError("conflict", "the master account's role cannot be changed");
    }
    if (userType === "master") {
      throw new SupremeError("validation_failed", "a user cannot be promoted to master — there can only be one");
    }
    const next: User = { ...user, userType };
    await this.store.putUser(next);
    return next;
  }

  /**
   * Proactively expire time-limited users whose `expiresAt` has passed (§8). The policy engine
   * already DENIES their actions, but until their status flips they can still authenticate and hold
   * a session — so flipping `active → expired` moves enforcement to the auth layer (their tokens
   * then fail `authenticate`). Returns the ids newly expired; the caller audits them.
   */
  async sweepExpired(nowMs: number = Date.now()): Promise<UserId[]> {
    const expired: UserId[] = [];
    for (const u of await this.store.listUsers()) {
      if (u.status === "active" && u.userType !== "master" && u.expiresAt && new Date(u.expiresAt).getTime() <= nowMs) {
        await this.store.putUser({ ...u, status: "expired" });
        expired.push(u.id);
      }
    }
    return expired;
  }

  private async issueTokens(user: User, sid: string, jti: string): Promise<TokenPair> {
    const base = { sub: user.id, homeId: user.homeId, userType: user.userType };
    return {
      accessToken: await this.tokens.issueAccess({ ...base, sid }),
      refreshToken: await this.tokens.issueRefresh({ ...base, sid, jti }),
      expiresIn: this.tokens.accessTtl,
      tokenType: "Bearer",
    };
  }

  private async requireHome(): Promise<Home> {
    const home = await this.store.getHome();
    if (!home) throw new SupremeError("conflict", "home is not commissioned yet");
    return home;
  }
}

// A fixed-cost hash to equalize timing for unknown emails (anti-enumeration).
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZS1zYWx0LXZhbHVl$3hAOFZ8gQ0z0r0o3o1mYg2hF0p1JxqZ2";
async function dummyVerify(password: string): Promise<boolean> {
  try {
    await verify(DUMMY_HASH, password);
  } catch {
    /* expected */
  }
  return false;
}

/** Hash a reset token so the raw value is never held in memory or compared directly. */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Format recovery-code bytes as a readable "xxxx-xxxx" Crockford-base32 string (no ambiguous chars). */
function formatRecoveryCode(bytes: Buffer): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford (no i/l/o/u)
  let out = "";
  for (const b of bytes) out += alphabet[b % 32]! + alphabet[(b >> 3) % 32]!;
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}
