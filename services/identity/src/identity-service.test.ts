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
