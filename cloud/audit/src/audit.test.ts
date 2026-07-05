import { describe, expect, it } from "vitest";
import { AuditLog, InMemoryAuditStore, type AuditEntry } from "./index.js";

function log() {
  let t = 1_750_000_000_000;
  return new AuditLog({ store: new InMemoryAuditStore(), now: () => t++ });
}

describe("AuditLog — append + chain", () => {
  it("appends entries with increasing seq and a linked hash chain", () => {
    const a = log();
    const e0 = a.append({ scope: "home", homeId: "h1", actorKind: "user", actorAccountId: "u1", action: "hub.claimed" });
    const e1 = a.append({ scope: "home", homeId: "h1", actorKind: "user", actorAccountId: "u1", action: "role.granted" });
    expect(e0.seq).toBe(0);
    expect(e1.seq).toBe(1);
    expect(e1.prevHash).toBe(e0.entryHash);
    expect(a.verify().valid).toBe(true);
  });

  it("queries by home/action/time", () => {
    const a = log();
    a.append({ scope: "home", homeId: "h1", actorKind: "user", action: "login" });
    a.append({ scope: "home", homeId: "h2", actorKind: "user", action: "login" });
    a.append({ scope: "home", homeId: "h1", actorKind: "user", action: "unlock" });
    expect(a.query({ homeId: "h1" })).toHaveLength(2);
    expect(a.query({ action: "login" })).toHaveLength(2);
  });
});

describe("AuditLog — tamper evidence", () => {
  it("detects a modified entry", () => {
    const store = new InMemoryAuditStore();
    const a = new AuditLog({ store, now: (() => { let t = 1_750_000_000_000; return () => t++; })() });
    a.append({ scope: "home", homeId: "h1", actorKind: "user", action: "hub.claimed" });
    a.append({ scope: "home", homeId: "h1", actorKind: "user", action: "role.granted", metadata: { role: "admin" } });
    a.append({ scope: "home", homeId: "h1", actorKind: "user", action: "unlock" });

    // Tamper: someone edits the granted role in place (e.g. privilege escalation).
    const entries = store.all();
    (entries[1] as AuditEntry).metadata = { role: "owner" };

    const res = a.verify();
    expect(res.valid).toBe(false);
    expect(res.brokenAt).toBe(1);
  });

  it("detects a deleted entry (chain break)", () => {
    const store = new InMemoryAuditStore();
    const a = new AuditLog({ store });
    a.append({ scope: "cloud", actorKind: "system", action: "a" });
    a.append({ scope: "cloud", actorKind: "system", action: "b" });
    a.append({ scope: "cloud", actorKind: "system", action: "c" });
    // Remove the middle entry — the next entry's prevHash no longer matches.
    const all = store.all();
    (store as unknown as { entries: AuditEntry[] }).entries = [all[0]!, all[2]!];
    expect(a.verify().valid).toBe(false);
  });
});
