import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { issueMobileAuthorizationToken } from "@supreme/hub-identity";
import type { Device, LoginResponse } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Contract drift gate (Phase 3, step 8) — the gateway's REAL wire shapes for everything the
 * homeowner client reads, pinned to `packages/domain-model/fixtures/wire-shapes.json`.
 *
 * The Dart simulator (`SimulatedResidence`) is held to the SAME fixture by
 * `apps/new/shared/test/wire_conformance_test.dart`, so the simulator cannot drift from the
 * gateway silently: a gateway change fails THIS test until the fixture is regenerated
 * (`UPDATE_WIRE_SHAPES=1`), which in turn fails the Dart test until the simulator follows.
 * Contract → Dart parity → simulator → client.
 *
 * A shape is structural only (keys and JSON types): values are never pinned. `null` in a sample
 * means "nullable here" and matches any type on the Dart side.
 */
type Shape = string | Shape[] | { [k: string]: Shape };

/**
 * Objects whose keys are open by contract, so their content is not a shape: a scene step's `values`
 * is a free-form command, and a capability's `config` and a device's `metadata` differ per driver.
 * They are recorded as `"object"` (any object).
 */
const OPEN_KEYS = new Set(["values", "config", "metadata"]);

function shapeOf(v: unknown, key?: string): Shape {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return v.length === 0 ? ["empty"] : [merge(v.map((x) => shapeOf(x)))];
  if (typeof v === "object") {
    if (key !== undefined && OPEN_KEYS.has(key)) return "object";
    const out: { [k: string]: Shape } = {};
    for (const k of Object.keys(v as object).sort()) out[k] = shapeOf((v as Record<string, unknown>)[k], k);
    return out;
  }
  return typeof v; // string | number | boolean
}

/**
 * Union of samples of one array's elements: a key seen anywhere is present, and is marked
 * optional (`key?`) when some element lacks it; null yields to a real type.
 */
function merge(shapes: Shape[]): Shape {
  return shapes.reduce((a, b) => mergeTwo(a, b));
}
const bare = (k: string) => (k.endsWith("?") ? k.slice(0, -1) : k);
function mergeTwo(a: Shape, b: Shape): Shape {
  if (a === "null") return b;
  if (b === "null") return a;
  if (a === "empty" || (Array.isArray(a) && a[0] === "empty")) return b;
  if (b === "empty" || (Array.isArray(b) && b[0] === "empty")) return a;
  if (Array.isArray(a) && Array.isArray(b)) return [mergeTwo(a[0]!, b[0]!)];
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = new Map(Object.keys(a).map((k) => [bare(k), k]));
    const kb = new Map(Object.keys(b).map((k) => [bare(k), k]));
    const out: { [k: string]: Shape } = {};
    for (const name of [...new Set([...ka.keys(), ...kb.keys()])].sort()) {
      const ea = ka.get(name);
      const eb = kb.get(name);
      const optional = !ea || !eb || ea.endsWith("?") || eb.endsWith("?");
      const shape = ea && eb ? mergeTwo(a[ea]!, b[eb]!) : (ea ? a[ea] : b[eb!])!;
      out[optional ? `${name}?` : name] = shape;
    }
    return out;
  }
  return a === b ? a : "mixed";
}

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/domain-model/fixtures/wire-shapes.json");

describe("wire shapes the homeowner client reads (real gateway)", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let base: string;
  let wsBase: string;
  let mobile: string;
  let owner: string;
  const live: Record<string, Shape> = {};

  const j = (token: string, extra: RequestInit = {}): RequestInit => ({
    ...extra,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(extra.headers ?? {}) },
  });

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
    ctx.mobileAuthorizations.upsert({
      mobileId: "m1", publicKeyBase64: "pk", hubId: ctx.hubIdentity.hubUuid, projectId: ctx.homeId,
      label: "Test Mobile", pairedAt: new Date().toISOString(), lastSeenAt: null, revoked: false, revokedAt: null,
    });
    mobile = issueMobileAuthorizationToken(ctx.hubIdentity, { mobileId: "m1", hubId: ctx.hubIdentity.hubUuid, projectId: ctx.homeId });
    const res = await fetch(`${base}/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@supreme.local", password: "supreme-owner-demo-pass" }),
    });
    const body = (await res.json()) as LoginResponse;
    if (body.status !== "ok") throw new Error("login");
    owner = body.accessToken;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  it("records every shape", async () => {
    const get = async (path: string) => (await (await fetch(`${base}${path}`, j(mobile))).json()) as Record<string, unknown>;

    live.home = shapeOf(await get("/v1/home"));
    const { devices } = (await get("/v1/devices")) as { devices: Device[] };
    live.devices = shapeOf({ devices });

    // An Experience authored with a line and phases — the Hub owns authoring.
    const lit = devices.filter((d) => d.roomId && d.capabilities.some((c) => c.kind === "brightness" || c.kind === "onoff"));
    const two = [...new Map(lit.map((d) => [d.roomId, d])).values()].slice(0, 2);
    expect(two.length).toBe(2);
    const stepFor = (d: Device, level: number) =>
      d.capabilities.some((c) => c.kind === "brightness")
        ? { deviceId: d.id, capability: "brightness", values: { action: "set", level } }
        : { deviceId: d.id, capability: "onoff", values: { action: "on" } };
    const created = await fetch(`${base}/v1/scenes`, j(owner, {
      method: "POST",
      body: JSON.stringify({
        name: "Shape Probe", scope: "home", roomId: null, icon: null,
        steps: two.map((d) => stepFor(d, 33)),
        description: "A probe", phases: [[0], [1]],
      }),
    }));
    expect(created.status).toBe(201);
    const sceneId = ((await created.json()) as { scene: { id: string } }).scene.id;
    live.scenes = shapeOf(await get("/v1/scenes"));

    // Frames come off the real stream.
    const frames: Record<string, unknown> = {};
    const ws = new WebSocket(`${wsBase}/v1/stream?access_token=${encodeURIComponent(mobile)}`);
    await new Promise<void>((r) => ws.on("open", () => { ws.send(JSON.stringify({ type: "subscribe", rooms: ["*"] })); setTimeout(r, 50); }));
    const gotBoth = new Promise<void>((resolveBoth, reject) => {
      const t = setTimeout(() => reject(new Error(`frames seen: ${Object.keys(frames)}`)), 8000);
      ws.on("message", (raw: Buffer) => {
        const f = JSON.parse(raw.toString()) as { type: string };
        if (f.type === "run" || f.type === "state") frames[f.type] = f;
        if (frames.run && frames.state) { clearTimeout(t); resolveBoth(); }
      });
    });
    const act = await fetch(`${base}/v1/scenes/${sceneId}/activate`, j(mobile, { method: "POST", body: "{}" }));
    expect(act.status).toBe(202);
    live.activate = shapeOf(await act.json());
    await gotBoth;
    ws.close();
    live.runFrame = shapeOf(frames.run);
    // A state frame's `state` is one capability's report — its keys depend on `kind` (each
    // capability's fields are pinned by `devices`), so the frame is pinned by its envelope and the
    // Dart side also asserts `state.kind` is a string.
    expect(typeof (frames.state as { state: { kind?: unknown } }).state.kind).toBe("string");
    live.stateFrame = { ...(shapeOf({ ...(frames.state as object), state: null }) as { [k: string]: Shape }), state: "object" };

    const cmd = await fetch(`${base}/v1/devices/${two[0]!.id}/command`, j(mobile, {
      method: "POST", body: JSON.stringify({ command: { capability: "onoff", action: "on" } }),
    }));
    // The response's `device` is a Device: pinned once, by the (all-capabilities) devices shape.
    const cmdBody = (await cmd.json()) as { accepted: boolean; device?: unknown };
    live.command = {
      ...(shapeOf({ ...cmdBody, device: null }) as { [k: string]: Shape }),
      device: ((live.devices as { devices: Shape[] }).devices)[0]!,
    };
  });

  it("matches the pinned fixture (UPDATE_WIRE_SHAPES=1 to regenerate, then update the simulator)", () => {
    expect(Object.keys(live).sort()).toEqual(["activate", "command", "devices", "home", "runFrame", "scenes", "stateFrame"]);
    const text = JSON.stringify(live, null, 2) + "\n";
    if (process.env.UPDATE_WIRE_SHAPES === "1" || !existsSync(FIXTURE)) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, text);
      return;
    }
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(JSON.parse(text));
  });
});
