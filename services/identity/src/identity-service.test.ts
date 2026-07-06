import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IdentityService } from "./identity-service.js";
import { InMemoryWebAuthnStore } from "./store.js";
import { totpAt } from "./totp.js";

const SECRET = "test-secret-test-secret-test-secret-123";

function svc() {
  return new IdentityService({ tokenSecret: SECRET });
}

describe("commissioning", () => {
  it("creates a master user and rejects a second commission", async () => {
    const s = svc();
    const { home, master } = await s.commission({
      homeName: "Penthouse",
      email: "owner@example.com",
      password: "correct horse battery staple",
      displayName: "Owner",
    });
    expect(master.userType).toBe("master");
    expect(home.masterUserId).toBe(master.id);
    await expect(
      s.commission({ homeName: "X", email: "a@b.com", password: "xxxxxxxxxxxx", displayName: "X" }),
    ).rejects.toThrow(/already commissioned/);
  });
});

describe("login + token lifecycle", () => {
  it("logs in and issues working access/refresh tokens", async () => {
    const s = svc();
    await s.commission({
      homeName: "Penthouse",
      email: "owner@example.com",
      password: "correct horse battery staple",
      displayName: "Owner",
    });
    const res = await s.login("owner@example.com", "correct horse battery staple");
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;

    const user = await s.authenticate(res.accessToken);
    expect(user.email).toBe("owner@example.com");

    const pair = await s.refresh(res.refreshToken);
    expect(pair.accessToken).toBeTruthy();
  });

  it("rotates refresh tokens and detects reuse of a rotated token", async () => {
    const s = svc();
    await s.commission({
      homeName: "Penthouse",
      email: "owner@example.com",
      password: "correct horse battery staple",
      displayName: "Owner",
    });
    const login = await s.login("owner@example.com", "correct horse battery staple");
    if (login.status !== "ok") throw new Error("expected tokens");

    // First refresh works and returns a NEW refresh token.
    const rotated = await s.refresh(login.refreshToken);
    expect(rotated.refreshToken).not.toBe(login.refreshToken);

    // The new refresh token still works once...
    const rotated2 = await s.refresh(rotated.refreshToken);
    expect(rotated2.accessToken).toBeTruthy();

    // ...but replaying the ORIGINAL (already-rotated) token is reuse → rejected,
    // and it revokes the whole session.
    await expect(s.refresh(login.refreshToken)).rejects.toThrow(/reuse detected/);
    await expect(s.refresh(rotated2.refreshToken)).rejects.toThrow(/revoked/);
  });

  it("enrolls TOTP MFA and requires it on subsequent logins", async () => {
    const s = svc();
    const { master } = await s.commission({
      homeName: "Penthouse",
      email: "owner@example.com",
      password: "correct horse battery staple",
      displayName: "Owner",
    });

    // Enroll: get a secret, confirm with a valid code.
    const { secret } = await s.startMfaEnrollment(master.id);
    await expect(s.confirmMfaEnrollment(master.id, "000000")).rejects.toThrow(/invalid/);
    await s.confirmMfaEnrollment(master.id, totpAt(secret));
    expect(await s.hasMfa(master.id)).toBe(true);

    // Login now requires a second factor.
    const login = await s.login("owner@example.com", "correct horse battery staple");
    expect(login.status).toBe("mfa_required");
    if (login.status !== "mfa_required") return;

    // Wrong code rejected; correct code completes login.
    await expect(s.verifyMfaLogin(login.mfaToken, "000000")).rejects.toThrow(/invalid/);
    const pair = await s.verifyMfaLogin(login.mfaToken, totpAt(secret));
    expect((await s.authenticate(pair.accessToken)).email).toBe("owner@example.com");
  });

  it("generates recovery codes and accepts one instead of TOTP, consuming it (§ recovery codes)", async () => {
    const s = svc();
    const { master } = await s.commission({ homeName: "P", email: "owner@example.com", password: "correct horse battery staple", displayName: "O" });

    // Can't generate recovery codes before MFA is on.
    await expect(s.regenerateRecoveryCodes(master.id)).rejects.toThrow(/enable two-factor/);
    const { secret } = await s.startMfaEnrollment(master.id);
    await s.confirmMfaEnrollment(master.id, totpAt(secret));

    const codes = await s.regenerateRecoveryCodes(master.id);
    expect(codes).toHaveLength(10);
    expect((await s.recoveryCodeStatus(master.id)).remaining).toBe(10);

    // Log in using a RECOVERY code instead of the authenticator; it is then consumed.
    const login = await s.login("owner@example.com", "correct horse battery staple");
    if (login.status !== "mfa_required") throw new Error("expected mfa");
    const pair = await s.verifyMfaLogin(login.mfaToken, codes[0]!);
    expect((await s.authenticate(pair.accessToken)).email).toBe("owner@example.com");
    expect((await s.recoveryCodeStatus(master.id)).remaining).toBe(9);

    // The same code can't be reused.
    const login2 = await s.login("owner@example.com", "correct horse battery staple");
    if (login2.status !== "mfa_required") throw new Error("expected mfa");
    await expect(s.verifyMfaLogin(login2.mfaToken, codes[0]!)).rejects.toThrow(/invalid/);

    // Disabling MFA clears the codes.
    await s.disableMfa(master.id, totpAt(secret));
    expect(await s.recoveryCodeStatus(master.id)).toEqual({ mfaEnabled: false, remaining: 0 });
  });

  it("revokes a session on logout so its access token stops working", async () => {
    const s = svc();
    await s.commission({
      homeName: "Penthouse",
      email: "owner@example.com",
      password: "correct horse battery staple",
      displayName: "Owner",
    });
    const login = await s.login("owner@example.com", "correct horse battery staple");
    if (login.status !== "ok") throw new Error("expected tokens");

    // Access token works, then logout revokes the session, then it fails.
    expect((await s.authenticate(login.accessToken)).email).toBe("owner@example.com");
    await s.logout(login.accessToken);
    await expect(s.authenticate(login.accessToken)).rejects.toThrow(/revoked/);
    await expect(s.refresh(login.refreshToken)).rejects.toThrow(/revoked/);
  });

  it("rejects a bad password without leaking user existence", async () => {
    const s = svc();
    await s.commission({
      homeName: "Penthouse",
      email: "owner@example.com",
      password: "correct horse battery staple",
      displayName: "Owner",
    });
    await expect(s.login("owner@example.com", "wrong")).rejects.toThrow(/invalid email or password/);
    await expect(s.login("ghost@example.com", "wrong")).rejects.toThrow(/invalid email or password/);
  });
});

describe("password reset + change", () => {
  it("resets a forgotten password with a one-time token, then logs in with the new one", async () => {
    const s = svc();
    await s.commission({ homeName: "Penthouse", email: "owner@example.com", password: "old-password-123", displayName: "Owner" });
    const reset = await s.requestPasswordReset("owner@example.com");
    expect(reset).not.toBeNull();
    await s.resetPassword(reset!.token, "brand-new-password-456");
    // Old password no longer works; new one does.
    await expect(s.login("owner@example.com", "old-password-123")).rejects.toThrow(/invalid email or password/);
    expect((await s.login("owner@example.com", "brand-new-password-456")).status).toBe("ok");
    // The token is one-time.
    await expect(s.resetPassword(reset!.token, "another-password-789")).rejects.toThrow(/invalid or expired/);
  });

  it("requestPasswordReset is silent for an unknown email (anti-enumeration)", async () => {
    const s = svc();
    expect(await s.requestPasswordReset("nobody@example.com")).toBeNull();
  });

  it("changes a password only when the current one is correct", async () => {
    const s = svc();
    const { master } = await s.commission({ homeName: "Penthouse", email: "owner@example.com", password: "current-password-123", displayName: "Owner" });
    await expect(s.changePassword(master.id, "wrong-password", "new-password-456")).rejects.toThrow(/current password is incorrect/);
    await expect(s.changePassword(master.id, "current-password-123", "short")).rejects.toThrow(/at least 8 characters/);
    await s.changePassword(master.id, "current-password-123", "new-password-456");
    expect((await s.login("owner@example.com", "new-password-456")).status).toBe("ok");
  });
});

describe("password policy + brute-force lockout", () => {
  it("rejects a too-common password and enforces the minimum length", async () => {
    const s = svc();
    await expect(
      s.commission({ homeName: "P", email: "owner@example.com", password: "password123", displayName: "O" }),
    ).rejects.toThrow(/too common/);
    await expect(
      s.commission({ homeName: "P", email: "owner@example.com", password: "short", displayName: "O" }),
    ).rejects.toThrow(/at least 8/);
    // A strong password commissions fine, and change/reset enforce the same policy.
    const { master } = await s.commission({ homeName: "P", email: "owner@example.com", password: "a-strong-passphrase", displayName: "O" });
    await expect(s.changePassword(master.id, "a-strong-passphrase", "12345678")).rejects.toThrow(/too common/);
  });

  it("locks an account after repeated failed logins, then unlocks after the cooldown", async () => {
    const s = new IdentityService({ tokenSecret: SECRET, maxLoginAttempts: 3, lockoutMs: 60_000 });
    await s.commission({ homeName: "P", email: "owner@example.com", password: "a-strong-passphrase", displayName: "O" });

    // Three wrong attempts → the fourth is locked out (even with the CORRECT password).
    for (let i = 0; i < 3; i++) {
      await expect(s.login("owner@example.com", "wrong")).rejects.toThrow(/invalid email or password/);
    }
    await expect(s.login("owner@example.com", "a-strong-passphrase")).rejects.toThrow(/too many failed attempts/);
  });

  it("clears the failure counter on a successful login", async () => {
    const s = new IdentityService({ tokenSecret: SECRET, maxLoginAttempts: 3, lockoutMs: 60_000 });
    await s.commission({ homeName: "P", email: "owner@example.com", password: "a-strong-passphrase", displayName: "O" });
    await expect(s.login("owner@example.com", "wrong")).rejects.toThrow(/invalid/);
    await expect(s.login("owner@example.com", "wrong")).rejects.toThrow(/invalid/);
    expect((await s.login("owner@example.com", "a-strong-passphrase")).status).toBe("ok"); // resets counter
    // Two fresh failures don't trip the (3-attempt) lock because the counter was cleared.
    await expect(s.login("owner@example.com", "wrong")).rejects.toThrow(/invalid/);
    await expect(s.login("owner@example.com", "wrong")).rejects.toThrow(/invalid/);
    expect((await s.login("owner@example.com", "a-strong-passphrase")).status).toBe("ok");
  });
});

describe("email verification", () => {
  it("verifies an invited user's email with a one-time token; changing email un-verifies it", async () => {
    const s = svc();
    const { home, master } = await s.commission({ homeName: "P", email: "owner@example.com", password: "a-strong-passphrase", displayName: "O" });
    // The master (who commissions the home) is verified on creation.
    expect(master.emailVerified).toBe(true);

    const guest = await s.createUser({ homeId: home.id, email: "guest@example.com", password: "guest-passphrase", displayName: "G", userType: "guest", expiresAt: null });
    expect(guest.emailVerified).toBe(false);

    const req = await s.requestEmailVerification(guest.id);
    if (!req) throw new Error("expected a token");
    await expect(s.verifyEmail("wrong-token")).rejects.toThrow(/invalid or expired/);
    const verified = await s.verifyEmail(req.token);
    expect(verified.emailVerified).toBe(true);
    // Requesting again for an already-verified user is a no-op.
    expect(await s.requestEmailVerification(guest.id)).toBeNull();

    // Changing the email drops verification; a stale token for the old address no longer applies.
    const req2 = await s.requestEmailVerification(guest.id); // null (still verified)
    expect(req2).toBeNull();
    const moved = await s.changeEmail(guest.id, "guest2@example.com", "guest-passphrase");
    expect(moved.emailVerified).toBe(false);
  });
});

describe("passkey (WebAuthn) login", () => {
  it("verifies a real ES256 assertion for a registered credential and issues tokens", async () => {
    const webAuthnStore = new InMemoryWebAuthnStore();
    const s = new IdentityService({ tokenSecret: SECRET, webAuthnStore });
    const { master } = await s.commission({ homeName: "P", email: "owner@example.com", password: "a-strong-passphrase", displayName: "O" });

    // Seed a passkey credential (as registration would) with a generated P-256 key.
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const credentialId = Buffer.from("cred-123").toString("base64url");
    await webAuthnStore.create({
      id: "pk1", userId: master.id, credentialId,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      signCount: 0, name: "Test Key", createdAt: new Date().toISOString(), lastUsedAt: null,
    });

    // Begin → get a server challenge → sign the exact WebAuthn message → finish.
    const { challenge } = s.beginPasskeyAuthentication();
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: "https://hub.local" }));
    const authData = Buffer.concat([Buffer.alloc(32, 1), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
    const message = Buffer.concat([authData, createHash("sha256").update(clientData).digest()]);
    const signature = cryptoSign("sha256", message, privateKey);

    const pair = await s.finishPasskeyAuthentication({
      credentialId,
      clientDataJSON: clientData.toString("base64url"),
      authenticatorData: authData.toString("base64url"),
      signature: signature.toString("base64url"),
    });
    expect((await s.authenticate(pair.accessToken)).id).toBe(master.id);

    // A replayed challenge (single-use) is rejected.
    await expect(s.finishPasskeyAuthentication({
      credentialId, clientDataJSON: clientData.toString("base64url"),
      authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url"),
    })).rejects.toThrow(/challenge expired/);

    // An unknown credential is rejected.
    await expect(s.finishPasskeyAuthentication({
      credentialId: "nope", clientDataJSON: clientData.toString("base64url"),
      authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url"),
    })).rejects.toThrow(/unknown passkey/);
  });
});

describe("personal API tokens", () => {
  it("issues a token that authenticates, then stops working once revoked", async () => {
    const s = svc();
    const { master } = await s.commission({ homeName: "P", email: "owner@example.com", password: "a-strong-passphrase", displayName: "O" });

    const { token, meta } = await s.createApiToken(master.id, "CI script");
    expect(token.startsWith("sup_pat_")).toBe(true);
    expect(meta.name).toBe("CI script");
    // The token authenticates directly as the user (no login/JWT).
    expect((await s.authenticate(token)).id).toBe(master.id);

    // It appears in the list (metadata only, no secret) and last-used is set after auth.
    const list = await s.listApiTokens(master.id);
    expect(list).toHaveLength(1);
    expect((list[0] as { tokenHash?: string }).tokenHash).toBeUndefined();
    expect(list[0]!.lastUsedAt).not.toBeNull();

    await s.revokeApiToken(master.id, meta.id);
    await expect(s.authenticate(token)).rejects.toThrow(/invalid API token/);
    expect(await s.listApiTokens(master.id)).toHaveLength(0);
  });

  it("rejects a garbage or non-owned token", async () => {
    const s = svc();
    await s.commission({ homeName: "P", email: "owner@example.com", password: "a-strong-passphrase", displayName: "O" });
    await expect(s.authenticate("sup_pat_not-a-real-token")).rejects.toThrow(/invalid API token/);
  });
});

describe("account self-service (change email + delete)", () => {
  it("changes the email only with the correct password and rejects a duplicate", async () => {
    const s = svc();
    const { home, master } = await s.commission({ homeName: "Penthouse", email: "owner@example.com", password: "owner-password-123", displayName: "Owner" });
    const guest = await s.createUser({ homeId: home.id, email: "guest@example.com", password: "guest-password-123", displayName: "Guest", userType: "guest", expiresAt: null });

    await expect(s.changeEmail(master.id, "new@example.com", "wrong")).rejects.toThrow(/current password is incorrect/);
    // Can't take an email another user already has.
    await expect(s.changeEmail(master.id, "guest@example.com", "owner-password-123")).rejects.toThrow(/already exists/);

    const updated = await s.changeEmail(master.id, "owner2@example.com", "owner-password-123");
    expect(updated.email).toBe("owner2@example.com");
    expect((await s.login("owner2@example.com", "owner-password-123")).status).toBe("ok");
    expect(guest.id).toBeDefined();
  });

  it("deletes a non-master account, revoking access; the master is protected", async () => {
    const s = svc();
    const { home, master } = await s.commission({ homeName: "Penthouse", email: "owner@example.com", password: "owner-password-123", displayName: "Owner" });
    const guest = await s.createUser({ homeId: home.id, email: "guest@example.com", password: "guest-password-123", displayName: "Guest", userType: "guest", expiresAt: null });
    const login = await s.login("guest@example.com", "guest-password-123");
    if (login.status !== "ok") throw new Error("expected tokens");

    // Wrong password → no self-delete.
    await expect(s.deleteOwnAccount(guest.id, "nope")).rejects.toThrow(/current password is incorrect/);
    // The master (owner) can never be deleted.
    await expect(s.deleteUser(master.id)).rejects.toThrow(/master .*cannot be deleted/);

    await s.deleteOwnAccount(guest.id, "guest-password-123");
    await expect(s.getUser(guest.id)).rejects.toThrow(/not found/);
    // The deleted user's token no longer authenticates, and they can't log back in.
    await expect(s.authenticate(login.accessToken)).rejects.toThrow(/no longer valid/);
    await expect(s.login("guest@example.com", "guest-password-123")).rejects.toThrow(/invalid email or password/);
  });
});

describe("Security Center — sessions & remote logout", () => {
  it("lists sessions with capture metadata, flags the current one, and revokes remotely", async () => {
    const s = svc();
    await s.commission({ homeName: "Penthouse", email: "owner@example.com", password: "owner-password-123", displayName: "Owner" });

    // Two logins from two "devices" → two sessions with captured ip/userAgent.
    const a = await s.login("owner@example.com", "owner-password-123", { ip: "10.0.0.2", userAgent: "iPhone" });
    const b = await s.login("owner@example.com", "owner-password-123", { ip: "10.0.0.3", userAgent: "MacBook" });
    if (a.status !== "ok" || b.status !== "ok") throw new Error("expected tokens");

    const me = (await s.authenticateSession(a.accessToken)).user;
    const list = await s.listSessions(me.id);
    expect(list).toHaveLength(2);
    expect(list.map((x) => x.ip).sort()).toEqual(["10.0.0.2", "10.0.0.3"]);
    expect(list.every((x) => !x.revoked)).toBe(true);

    // Revoke device B's session from device A → B's token stops working, A still works.
    const bSid = (await s.authenticateSession(b.accessToken)).sid!;
    await s.revokeSession(me.id, bSid);
    await expect(s.authenticate(b.accessToken)).rejects.toThrow(/revoked/);
    expect((await s.authenticateSession(a.accessToken)).user.id).toBe(me.id);
  });

  it("revoke-others keeps only the current session; ownership is enforced", async () => {
    const s = svc();
    const { home } = await s.commission({ homeName: "Penthouse", email: "owner@example.com", password: "owner-password-123", displayName: "Owner" });
    const other = await s.createUser({ homeId: home.id, email: "guest@example.com", password: "guest-password-123", displayName: "Guest", userType: "guest", expiresAt: null });

    const a = await s.login("owner@example.com", "owner-password-123");
    const b = await s.login("owner@example.com", "owner-password-123");
    const c = await s.login("owner@example.com", "owner-password-123");
    if (a.status !== "ok" || b.status !== "ok" || c.status !== "ok") throw new Error("expected tokens");
    const owner = (await s.authenticateSession(a.accessToken)).user;
    const keepSid = (await s.authenticateSession(a.accessToken)).sid!;

    const revoked = await s.revokeOtherSessions(owner.id, keepSid);
    expect(revoked).toBe(2);
    expect((await s.authenticateSession(a.accessToken)).user.id).toBe(owner.id); // kept
    await expect(s.authenticate(b.accessToken)).rejects.toThrow(/revoked/);
    await expect(s.authenticate(c.accessToken)).rejects.toThrow(/revoked/);

    // A user can't revoke a session that isn't theirs.
    const guestLogin = await s.login("guest@example.com", "guest-password-123");
    if (guestLogin.status !== "ok") throw new Error("expected tokens");
    const guestSid = (await s.authenticateSession(guestLogin.accessToken)).sid!;
    await expect(s.revokeSession(owner.id, guestSid)).rejects.toThrow(/not found/);
    expect(other.id).toBeDefined();
  });
});

describe("expiring (guest/temporary) access", () => {
  it("sweepExpired flips a past-expiry guest to 'expired' and their token stops authenticating", async () => {
    const s = svc();
    const { home } = await s.commission({ homeName: "Penthouse", email: "owner@example.com", password: "correct horse battery staple", displayName: "Owner" });
    // A guest whose access already ended (expiresAt in the past).
    const guest = await s.createUser({ homeId: home.id, email: "guest@example.com", password: "guest-temporary-pass", displayName: "Guest", userType: "guest", expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const login = await s.login("guest@example.com", "guest-temporary-pass");
    if (login.status !== "ok") throw new Error("expected tokens");
    // Before the sweep the token authenticates (only the policy denies actions).
    expect((await s.authenticate(login.accessToken)).id).toBe(guest.id);

    const expired = await s.sweepExpired();
    expect(expired).toContain(guest.id);
    expect((await s.getUser(guest.id)).status).toBe("expired");
    // Now the auth layer itself rejects the token.
    await expect(s.authenticate(login.accessToken)).rejects.toThrow(/no longer valid/);
  });

  it("leaves unexpired and master users untouched", async () => {
    const s = svc();
    const { home, master } = await s.commission({ homeName: "Penthouse", email: "owner@example.com", password: "correct horse battery staple", displayName: "Owner" });
    const future = await s.createUser({ homeId: home.id, email: "future@example.com", password: "future-guest-pass", displayName: "Future", userType: "guest", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const expired = await s.sweepExpired();
    expect(expired).toEqual([]);
    expect((await s.getUser(future.id)).status).toBe("active");
    expect((await s.getUser(master.id)).status).toBe("active");
  });
});
