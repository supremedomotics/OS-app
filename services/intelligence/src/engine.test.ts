import { describe, expect, it } from "vitest";
import { IntelligenceEngine, type IntelligenceModule, type ModuleResult } from "./engine.js";

const mod = (id: string, result: ModuleResult, opts: { throws?: boolean } = {}): IntelligenceModule => ({
  id,
  title: id,
  evaluate: () => {
    if (opts.throws) throw new Error(`${id} boom`);
    return result;
  },
});

const obs = (module: string) => ({ module, kind: "k", subject: "s", data: {}, confidence: 1, ts: 0 });
const sug = (module: string) => ({ key: `${module}:1`, module, kind: "k", title: "t", body: "b", actions: [] as never[], confidence: { decision: 1 }, ts: 0 });

describe("IntelligenceEngine", () => {
  it("registers modules and merges their observations + suggestions", async () => {
    const engine = new IntelligenceEngine()
      .register(mod("presence", { observations: [obs("presence")], suggestions: [] }))
      .register(mod("energy", { observations: [], suggestions: [sug("energy")] }));
    expect(engine.list().map((m) => m.id)).toEqual(["presence", "energy"]);

    const out = await engine.evaluate({ homeId: "home_1", now: 0 });
    expect(out.observations).toHaveLength(1);
    expect(out.suggestions).toHaveLength(1);
    expect(out.errors).toEqual({});
  });

  it("isolates a throwing module — others still run", async () => {
    const engine = new IntelligenceEngine()
      .register(mod("bad", { observations: [], suggestions: [] }, { throws: true }))
      .register(mod("good", { observations: [obs("good")], suggestions: [] }));
    const out = await engine.evaluate({ homeId: "home_1", now: 0 });
    expect(out.errors.bad).toContain("boom");
    expect(out.observations.map((o) => o.module)).toEqual(["good"]);
  });

  it("register replaces by id; unregister removes", () => {
    const engine = new IntelligenceEngine()
      .register(mod("x", { observations: [], suggestions: [] }))
      .register(mod("x", { observations: [obs("x")], suggestions: [] }));
    expect(engine.list()).toHaveLength(1);
    expect(engine.unregister("x")).toBe(true);
    expect(engine.has("x")).toBe(false);
  });
});
