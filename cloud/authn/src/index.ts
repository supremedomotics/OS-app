import { createHash, randomBytes, type KeyObject } from "node:crypto";
import { SignJWT, jwtVerify, exportJWK, type JWTPayload } from "jose";

/**
 * @supreme/cloud-authn — the cloud session + token engine (ADR 0007, blueprint §5).
 *
 * Off-LAN, Supreme Cloud is the sole identity provider. This service:
 *   • mints short-lived, EdDSA-signed ACCESS JWTs (audience-scoped: cloud API or a hub) that
 *     edges/hubs verify with the published JWKS — no shared secret;
 *   • issues opaque, device-bound, ROTATING refresh tokens. Every refresh rotates the pair
 *     (one-time-use). Re-presenting an already-rotated token is treated as theft and revokes
 *     the entire token family (reuse-detection), the standard OAuth refresh-rotation defense.
 *
 * Transport-agnostic core (store seam is injectable) so it is unit-testable without a DB.
 */

export type Audience = "supreme-cloud" | "supreme-hub";

export interface AccessClaims {
  /** Account id (the authenticated principal). */
  sub: string;
  /** Optional home/hub scope hint carried into the hub for local RBAC mapping. */
  home?: string;
  hub?: string;
  /** Authentication methods reference (e.g. ["pwd","otp"] or ["passkey"]). */
  amr: string[];
  /** Session id — binds the access token to a revocable session. */
  sid: string;
  /** Proof-of-possession confirmation: device cert / DPoP key thumbprint. */
  cnf?: string;
}

export interface RefreshRecord {
  /** sha256 of the opaque refresh secret (we never store the secret). */
  hash: string;
  sessionId: string;
  familyId: string;
  accountId: string;
  deviceId: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  /** Hash of the token this one rotated into (chain link, for audit). */
  rotatedTo: string | null;
  revokedAt: number | null;
}

/** Persistence seam — Postgres (`refresh_tokens`/`auth_sessions`) in prod; in-memory for tests. */
export interface IAuthnStore {
  getRefresh(hash: string): RefreshRecord | undefined;
  putRefresh(rec: RefreshRecord): void;
  /** Revoke every token in a family (reuse-detection / remote logout). */
  revokeFamily(familyId: string, at: number): void;
  isFamilyRevoked(familyId: string): boolean;
  /** Revoke a whole session (all its families). */
  revokeSession(sessionId: string, at: number): void;
  isSessionRevoked(sessionId: string): boolean;
}

export class InMemoryAuthnStore implements IAuthnStore {
  private refresh = new Map<string, RefreshRecord>();
  private revokedFamilies = new Set<string>();
  private revokedSessions = new Set<string>();

  getRefresh(hash: string) {
    return this.refresh.get(hash);
  }
  putRefresh(rec: RefreshRecord) {
    this.refresh.set(rec.hash, rec);
  }
  revokeFamily(familyId: string, at: number) {
    this.revokedFamilies.add(familyId);
    for (const r of this.refresh.values()) if (r.familyId === familyId && !r.revokedAt) r.revokedAt = at;
  }
  isFamilyRevoked(familyId: string) {
    return this.revokedFamilies.has(familyId);
  }
  revokeSession(sessionId: string, at: number) {
    this.revokedSessions.add(sessionId);
    for (const r of this.refresh.values()) if (r.sessionId === sessionId && !r.revokedAt) r.revokedAt = at;
  }
  isSessionRevoked(sessionId: string) {
    return this.revokedSessions.has(sessionId);
  }
}

export class AuthnError extends Error {
  constructor(
    readonly code: "invalid_grant" | "reuse_detected" | "expired" | "revoked",
    message: string,
  ) {
    super(message);
  }
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  familyId: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

export interface AuthnOptions {
  /** EdDSA signing keypair (Ed25519 KeyObjects). Public half is published as JWKS. */
  privateKey: KeyObject;
  publicKey: KeyObject;
  keyId?: string;
  issuer?: string;
  store?: IAuthnStore;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
  now?: () => number;
  newId?: (prefix: string) => string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export class AuthnService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly keyId: string;
  private readonly issuer: string;
  private readonly store: IAuthnStore;
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly now: () => number;
  private readonly newId: (prefix: string) => string;
  private seq = 0;

  constructor(opts: AuthnOptions) {
    this.privateKey = opts.privateKey;
    this.publicKey = opts.publicKey;
    this.keyId = opts.keyId ?? "authn-1";
    this.issuer = opts.issuer ?? "https://id.supreme.example";
    this.store = opts.store ?? new InMemoryAuthnStore();
    this.accessTtl = opts.accessTtlSeconds ?? 600; // 10 min
    this.refreshTtl = opts.refreshTtlSeconds ?? 60 * 60 * 24 * 30; // 30 days
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? ((p) => `${p}-${(++this.seq).toString(36)}-${this.now().toString(36)}`);
  }

  /** The JWKS the edge/hubs use to verify access tokens (key rotation publishes both keys). */
  async jwks(): Promise<{ keys: JWTPayload[] }> {
    const jwk = await exportJWK(this.publicKey);
    return { keys: [{ ...jwk, kid: this.keyId, use: "sig", alg: "EdDSA" } as unknown as JWTPayload] };
  }

  /** Start a new authenticated session: mint access + the first refresh of a new family. */
  async startSession(input: {
    accountId: string;
    deviceId: string;
    amr: string[];
    audience?: Audience;
    scope?: { home?: string; hub?: string };
    cnf?: string;
  }): Promise<IssuedTokens> {
    const sessionId = this.newId("sess");
    const familyId = this.newId("fam");
    return this.mint({ ...input, sessionId, familyId });
  }

  /**
   * Rotate a refresh token. Detects reuse of an already-rotated token and revokes the whole
   * family. Returns a fresh access + refresh pair on success.
   */
  async refresh(input: {
    refreshToken: string;
    audience?: Audience;
    scope?: { home?: string; hub?: string };
    cnf?: string;
  }): Promise<IssuedTokens> {
    const now = this.now();
    const rec = this.store.getRefresh(sha256(input.refreshToken));
    if (!rec) throw new AuthnError("invalid_grant", "unknown refresh token");
    if (this.store.isFamilyRevoked(rec.familyId) || this.store.isSessionRevoked(rec.sessionId) || rec.revokedAt) {
      throw new AuthnError("revoked", "token family or session revoked");
    }
    if (now >= rec.expiresAt) throw new AuthnError("expired", "refresh token expired");
    if (rec.usedAt !== null) {
      // This token was already rotated once — a second use means it was captured. Burn it all.
      this.store.revokeFamily(rec.familyId, now);
      throw new AuthnError("reuse_detected", "refresh token reuse detected; family revoked");
    }

    const next = await this.mint({
      accountId: rec.accountId,
      deviceId: rec.deviceId,
      amr: ["refresh"],
      audience: input.audience,
      scope: input.scope,
      cnf: input.cnf,
      sessionId: rec.sessionId,
      familyId: rec.familyId,
    });
    // Mark the old token consumed and link the chain (audit / reuse-detection).
    this.store.putRefresh({ ...rec, usedAt: now, rotatedTo: sha256(next.refreshToken) });
    return next;
  }

  /** Remote logout: revoke a device's session (its refresh families stop working at once). */
  revokeSession(sessionId: string): void {
    this.store.revokeSession(sessionId, this.now());
  }

  /** Verify an access token (what an edge/hub does on every request). */
  async verifyAccess(token: string, audience: Audience = "supreme-cloud"): Promise<AccessClaims> {
    const { payload } = await jwtVerify(token, this.publicKey, {
      issuer: this.issuer,
      audience,
      // Verify against the service clock so behavior is deterministic under an injected clock.
      currentDate: new Date(this.now()),
    });
    if (this.store.isSessionRevoked(payload.sid as string)) {
      throw new AuthnError("revoked", "session revoked");
    }
    return payload as unknown as AccessClaims;
  }

  private async mint(input: {
    accountId: string;
    deviceId: string;
    amr: string[];
    audience?: Audience;
    scope?: { home?: string; hub?: string };
    cnf?: string;
    sessionId: string;
    familyId: string;
  }): Promise<IssuedTokens> {
    const now = this.now();
    const claims: AccessClaims = {
      sub: input.accountId,
      amr: input.amr,
      sid: input.sessionId,
      ...(input.scope?.home ? { home: input.scope.home } : {}),
      ...(input.scope?.hub ? { hub: input.scope.hub } : {}),
      ...(input.cnf ? { cnf: input.cnf } : {}),
    };
    const accessExpiresAt = now + this.accessTtl * 1000;
    const accessToken = await new SignJWT({ ...claims } as unknown as JWTPayload)
      .setProtectedHeader({ alg: "EdDSA", kid: this.keyId })
      .setIssuedAt(Math.floor(now / 1000))
      .setIssuer(this.issuer)
      .setAudience(input.audience ?? "supreme-cloud")
      .setExpirationTime(Math.floor(accessExpiresAt / 1000))
      .sign(this.privateKey);

    const refreshSecret = randomBytes(32).toString("base64url");
    const refreshExpiresAt = now + this.refreshTtl * 1000;
    this.store.putRefresh({
      hash: sha256(refreshSecret),
      sessionId: input.sessionId,
      familyId: input.familyId,
      accountId: input.accountId,
      deviceId: input.deviceId,
      createdAt: now,
      expiresAt: refreshExpiresAt,
      usedAt: null,
      rotatedTo: null,
      revokedAt: null,
    });

    return {
      accessToken,
      refreshToken: refreshSecret,
      sessionId: input.sessionId,
      familyId: input.familyId,
      accessExpiresAt,
      refreshExpiresAt,
    };
  }
}

/** Generate an Ed25519 keypair for the AuthN signer (dev convenience). */
export { generateKeyPairSync } from "node:crypto";
