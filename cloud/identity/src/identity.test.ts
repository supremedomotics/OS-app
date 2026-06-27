import { describe, expect, it } from "vitest";
import { IdentityError, IdentityService, InMemoryIdentityStore } from "./index.js";

function svc() {
  return new IdentityService({ store: new InMemoryIdentityStore() });
}

describe("IdentityService — accounts & passwords", () => {
  it("registers an account with an identity + password and verifies it", async () => {
    const s = svc();
    const { account } = await s.register({ kind: "email", value: "Owner@Supreme.io", password: "s3cret-pass" });
    // Identity lookup is case-insensitive.
    const verified = await s.verifyPassword("email", "owner@supreme.io", "s3cret-pass");
    expect(verified).toBe(account.id);
  });

  it("rejects duplicate identities", async () => {
    const s = svc();
    await s.register({ kind: "email", value: "a@b.com", password: "x" });
    await expect(s.register({ kind: "email", value: "a@b.com" })).rejects.toBeInstanceOf(IdentityError);
  });

  it("rejects a wrong password (and an unknown identity) as invalid_credentials", async () => {
    const s = svc();
    await s.register({ kind: "email", value: "a@b.com", password: "right" });
    await expect(s.verifyPassword("email", "a@b.com", "wrong")).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(s.verifyPassword("email", "nobody@b.com", "x")).rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("supports multiple identities (email + phone + username) on one account", async () => {
    const s = svc();
    const { account } = await s.register({ kind: "email", value: "a@b.com", password: "p" });
    s.addIdentity(account.id, "phone", "+971500000000");
    s.addIdentity(account.id, "username", "mujeeb");
    expect(s.resolveIdentity("phone", "+971500000000")?.accountId).toBe(account.id);
    expect(s.resolveIdentity("username", "mujeeb")?.accountId).toBe(account.id);
  });
});

describe("IdentityService — federated login", () => {
  it("creates an account on first federated login and reuses it on the second", async () => {
    const s = svc();
    const first = await s.upsertFederated({ provider: "apple", subject: "apple-sub-1", email: "z@icloud.com" });
    expect(first.created).toBe(true);
    const second = await s.upsertFederated({ provider: "apple", subject: "apple-sub-1" });
    expect(second.created).toBe(false);
    expect(second.account.id).toBe(first.account.id);
  });

  it("links a federated login to an existing account by verified email", async () => {
    const s = svc();
    const { account } = await s.register({ kind: "email", value: "shared@x.com", password: "p" });
    const fed = await s.upsertFederated({ provider: "google", subject: "g-sub", email: "shared@x.com" });
    expect(fed.created).toBe(false);
    expect(fed.account.id).toBe(account.id);
  });
});

describe("IdentityService — passkeys", () => {
  it("registers and lists passkeys for an account", async () => {
    const s = svc();
    const { account } = await s.register({ kind: "email", value: "a@b.com", password: "p" });
    s.registerPasskey(account.id, { credentialId: "cred-1", publicKey: "pk", name: "iPhone Face ID" });
    expect(s.listPasskeys(account.id)).toHaveLength(1);
    expect(s.listPasskeys(account.id)[0]!.name).toBe("iPhone Face ID");
  });
});
