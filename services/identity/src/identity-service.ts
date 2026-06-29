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
  InMemoryIdentityStore,
  InMemorySessionStore,
  type IIdentityStore,
  type ISessionStore,
} from "./store.js";
import { TokenService } from "./tokens.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "./totp.js";

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
}

// OWASP-recommended Argon2id parameters.
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export class IdentityService {
  private readonly store: IIdentityStore;
  private readonly sessions: ISessionStore;
  /** Pending (un-activated) TOTP secrets during enrollment, keyed by user. */
  private readonly pendingMfa = new Map<UserId, string>();
  readonly tokens: TokenService;

  constructor(opts: IdentityServiceOptions) {
    this.store = opts.store ?? new InMemoryIdentityStore();
    this.sessions = opts.sessionStore ?? new InMemorySessionStore();
    this.tokens = new TokenService({ secret: opts.tokenSecret });
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

  async login(email: string, password: string): Promise<LoginResponse> {
    const user = await this.store.findUserByEmail(email);
    const cred = user ? await this.store.getCredential(user.id) : null;

    // Always run a verification to keep timing uniform whether or not the user exists.
    const ok = cred ? await verify(cred.passwordHash, password).catch(() => false) : await dummyVerify(password);
    if (!user || !cred || !ok) {
      throw new SupremeError("unauthorized", "invalid email or password");
    }
    if (user.status !== "active") {
      throw new SupremeError("forbidden", `account is ${user.status}`);
    }

    const base = { sub: user.id, homeId: user.homeId, userType: user.userType };
    if (cred.mfaSecret) {
      return { status: "mfa_required", mfaToken: await this.tokens.issueMfa(base) };
    }
    // New login → new revocable session, with the first refresh jti in the chain.
    const sid = newId("session") as string;
    const jti = newId("session") as string;
    await this.sessions.create({ id: sid, userId: user.id, currentJti: jti, revoked: false, createdAt: new Date().toISOString() });
    return { status: "ok", ...(await this.issueTokens(user, sid, jti)) };
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
    await this.sessions.setCurrentJti(claims.sid, nextJti);
    return this.issueTokens(user, claims.sid, nextJti);
  }

  /**
   * Complete an MFA-gated login: verify the 6-digit TOTP against the short-lived
   * mfa token issued by {@link login}, then issue access/refresh tokens.
   */
  async verifyMfaLogin(mfaToken: string, code: string): Promise<TokenPair> {
    const claims = await this.tokens.verify(mfaToken, "mfa");
    const user = await this.store.getUser(claims.sub);
    if (!user || user.status !== "active") {
      throw new SupremeError("unauthorized", "session is no longer valid");
    }
    const cred = await this.store.getCredential(user.id);
    if (!cred?.mfaSecret || !verifyTotp(cred.mfaSecret, code)) {
      throw new SupremeError("unauthorized", "invalid authentication code");
    }
    const sid = newId("session") as string;
    const jti = newId("session") as string;
    await this.sessions.create({ id: sid, userId: user.id, currentJti: jti, revoked: false, createdAt: new Date().toISOString() });
    return this.issueTokens(user, sid, jti);
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
    await this.store.putCredential({ ...cred, mfaSecret: null });
  }

  /** Whether a user has MFA enabled. */
  async hasMfa(userId: UserId): Promise<boolean> {
    return Boolean((await this.store.getCredential(userId))?.mfaSecret);
  }

  // ── Password reset (§ forgot-password) — Supreme-only, never touches HA ─────────
  /** One-time reset tokens keyed by their SHA-256 (we never store the raw token). */
  private readonly resetTokens = new Map<string, { userId: UserId; expiresAt: number }>();
  private static readonly RESET_TTL_MS = 30 * 60 * 1000;

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
    if (newPassword.length < 8) {
      throw new SupremeError("validation_failed", "password must be at least 8 characters");
    }
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

  /** Verify an access token and return the live user. Used by the gateway authn. */
  async authenticate(accessToken: string): Promise<User> {
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

  listUsers(): Promise<User[]> {
    return this.store.listUsers();
  }

  async getUser(id: UserId): Promise<User> {
    const user = await this.store.getUser(id);
    if (!user) throw new SupremeError("not_found", "user not found");
    return user;
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
