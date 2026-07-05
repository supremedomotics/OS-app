import { describe, expect, it } from "vitest";
import { IdentityService } from "./identity-service.js";
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
