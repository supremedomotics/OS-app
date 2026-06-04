import { newId, type HomeId, type UserId } from "@supreme/domain-model";
import { migrate, PgliteDb } from "@supreme/persistence";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditService } from "./index.js";

describe("AuditService — hash-chained tamper-evidence (PGlite)", () => {
  let db: PgliteDb;
  let audit: AuditService;
  const homeId = newId("home") as HomeId;
  const actor = newId("user") as UserId;

  beforeAll(async () => {
    db = await PgliteDb.create();
    await migrate(db);
    audit = new AuditService(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it("appends a linked chain and verifies it", async () => {
    const e1 = await audit.record({ homeId, actorUserId: actor, action: "login", resourceType: "user", resourceId: actor });
    const e2 = await audit.record({ homeId, actorUserId: actor, action: "control", resourceType: "device", resourceId: "dev_x", metadata: { level: 60 } });
    const e3 = await audit.record({ homeId, action: "admin", resourceType: "integration", resourceId: "supreme-knx" });

    expect(e1.seq).toBe(1);
    expect(e2.prevHash).toBe(e1.entryHash);
    expect(e3.prevHash).toBe(e2.entryHash);

    const list = await audit.list(homeId);
    expect(list).toHaveLength(3);
    expect(list[0]!.seq).toBe(3); // newest first

    expect(await audit.verify(homeId)).toEqual({ ok: true });
  });

  it("detects tampering with a historical entry", async () => {
    // Mutate entry seq=2's metadata directly in the DB — the chain must break there.
    await db.query("UPDATE audit_log SET metadata='{\"level\":1}'::jsonb WHERE home_id=$1 AND seq=2", [homeId]);
    const result = await audit.verify(homeId);
    expect(result.ok).toBe(false);
    expect(result.brokenAtSeq).toBe(2);
  });

  it("keeps per-home chains independent", async () => {
    const other = newId("home") as HomeId;
    const a = await audit.record({ homeId: other, action: "login", resourceType: "user", resourceId: null });
    expect(a.seq).toBe(1);
    expect(await audit.verify(other)).toEqual({ ok: true });
  });
});
