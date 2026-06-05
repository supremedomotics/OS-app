import { describe, expect, it } from "vitest";
import { IdentityService } from "./identity-service.js";

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
