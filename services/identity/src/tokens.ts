import type { HomeId, UserId, UserType } from "@supreme/domain-model";
import { SupremeError } from "@supreme/contracts";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

/**
 * Supreme token model (§12): short-lived access JWT + rotating refresh token.
 * Tokens are signed locally on the hub with an HS256 secret derived from the
 * hub's sealed key material, so identity validates fully offline.
 */
export interface SupremeClaims {
  sub: UserId;
  homeId: HomeId;
  userType: UserType;
  /** "access" | "refresh" | "mfa" — guards token reuse across flows. */
  kind: "access" | "refresh" | "mfa";
  /** Session id — binds the token to a revocable session (rotation/logout). */
  sid?: string;
  /** Token id — for refresh tokens, the rotation chain position (reuse detection). */
  jti?: string;
}

export interface TokenServiceOptions {
  secret: string;
  issuer?: string;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
}

export class TokenService {
  private readonly key: Uint8Array;
  private readonly issuer: string;
  readonly accessTtl: number;
  readonly refreshTtl: number;

  constructor(opts: TokenServiceOptions) {
    if (!opts.secret || opts.secret.length < 32) {
      throw new Error("TokenService requires a secret of at least 32 chars");
    }
    this.key = new TextEncoder().encode(opts.secret);
    this.issuer = opts.issuer ?? "supreme-hub";
    this.accessTtl = opts.accessTtlSeconds ?? 900; // 15 min
    this.refreshTtl = opts.refreshTtlSeconds ?? 60 * 60 * 24 * 30; // 30 days
  }

  private async sign(claims: SupremeClaims, ttl: number): Promise<string> {
    const body: Record<string, unknown> = { ...claims };
    // Drop undefined optional claims so they don't serialize as null.
    if (body.sid === undefined) delete body.sid;
    if (body.jti === undefined) delete body.jti;
    return new SignJWT(body)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(this.issuer)
      .setExpirationTime(`${ttl}s`)
      .sign(this.key);
  }

  issueAccess(claims: Omit<SupremeClaims, "kind">): Promise<string> {
    return this.sign({ ...claims, kind: "access" }, this.accessTtl);
  }
  issueRefresh(claims: Omit<SupremeClaims, "kind">): Promise<string> {
    return this.sign({ ...claims, kind: "refresh" }, this.refreshTtl);
  }
  issueMfa(claims: Omit<SupremeClaims, "kind">): Promise<string> {
    return this.sign({ ...claims, kind: "mfa" }, 300);
  }

  async verify(token: string, expected: SupremeClaims["kind"]): Promise<SupremeClaims> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.key, { issuer: this.issuer }));
    } catch {
      throw new SupremeError("unauthorized", "invalid or expired token");
    }
    if (payload.kind !== expected) {
      throw new SupremeError("unauthorized", `expected a ${expected} token`);
    }
    return {
      sub: payload.sub as UserId,
      homeId: payload.homeId as HomeId,
      userType: payload.userType as UserType,
      kind: payload.kind as SupremeClaims["kind"],
      sid: payload.sid as string | undefined,
      jti: payload.jti as string | undefined,
    };
  }
}
