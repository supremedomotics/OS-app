import { buildStores, migrate, PgliteDb } from "@supreme/persistence";
import type { AureonConverseResult } from "./aureon/aureon-service.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Aureon end-to-end, MVP slice (§ docs/architecture/aureon/AUREON-ARCHITECTURE.md).
 * Exercises the real HTTP surface — real Postgres-compatible persistence (Pglite),
 * real SIL, real PolicyEngine, real AuditService — proving the FLOW 2/6 examples
 * from the follow-up brief: a low-risk action executes and verifies; a high-risk
 * one is proposed, not executed, until confirmed; and a completed transaction can
 * be looked up and undone.
 */
describe("Aureon MVP: converse → policy → execute → verify → explain → undo", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let db: PgliteDb;
  let baseUrl: string;
  let token = "";

  beforeAll(async () => {
    db = await PgliteDb.create();
    await migrate(db);
    const s = buildStores(db);
    ctx = await AppContext.create(loadConfig({ SUPREME_LOG_LEVEL: "silent" }), {
      identityStore: s.identity,
      homeStore: s.home,
      sceneStore: s.scenes,
      grantStore: s.grants,
      notificationStore: s.notifications,
      driverStore: s.drivers,
      automationStore: s.automations,
      db,
    });
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;

    const login = (await (
      await fetch(`${baseUrl}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
      })
    ).json()) as { accessToken: string };
    token = login.accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
    await db.close();
  });

  const auth = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  async function converse(utterance: string, confirm?: boolean) {
    const res = await fetch(`${baseUrl}/v1/aureon/converse`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ utterance, confirm }),
    });
    return (await res.json()) as { result: AureonConverseResult };
  }

  it("executes and verifies a LOW_RISK action immediately, with an honest explanation", async () => {
    const { result } = await converse("turn on the kitchen lights");
    expect(result.kind).toBe("executed");
    if (result.kind !== "executed") throw new Error("expected executed");
    expect(result.transaction.riskLevel).toBe(1);
    expect(result.transaction.entries.length).toBeGreaterThan(0);
    // Never silently claims success beyond what verification actually found.
    for (const e of result.transaction.entries) {
      expect(["verified_success", "verified_failure", "unverified"]).toContain(e.status);
    }
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("proposes, but does NOT execute, a HIGH_RISK action (unlocking a door) without confirmation", async () => {
    const { result } = await converse("unlock the front door");
    expect(result.kind).toBe("proposal");
    if (result.kind !== "proposal") throw new Error("expected proposal");
    expect(result.riskLevel).toBe(3);
    expect(result.commands.some((c) => c.command.capability === "lock")).toBe(true);
  });

  it("executes the SAME high-risk request once confirm:true is sent, then can be undone", async () => {
    const { result } = await converse("unlock the front door", true);
    expect(result.kind).toBe("executed");
    if (result.kind !== "executed") throw new Error("expected executed");
    const txId = result.transaction.id;

    // The transaction is retrievable and auditable.
    const fetched = (await (
      await fetch(`${baseUrl}/v1/aureon/transactions/${txId}`, { headers: auth() })
    ).json()) as { transaction: { id: string } };
    expect(fetched.transaction.id).toBe(txId);

    // Undo replays the captured prior (locked) state — never a guessed inverse.
    const undoRes = await fetch(`${baseUrl}/v1/aureon/transactions/${txId}/undo`, {
      method: "POST",
      headers: auth(),
    });
    const undone = (await undoRes.json()) as { result: AureonConverseResult };
    expect(undone.result.kind).toBe("executed");
    if (undone.result.kind !== "executed") throw new Error("expected executed");
    expect(undone.result.transaction.undoOf).toBe(txId);
  });

  it("still leaves /v1/ai/assistant fully functional (no regression)", async () => {
    const res = await fetch(`${baseUrl}/v1/ai/assistant`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ utterance: "dim the living room lights" }),
    });
    const body = (await res.json()) as { result: { kind: string } };
    expect(res.status).toBe(200);
    expect(body.result.kind).toBe("actions");
  });
});
