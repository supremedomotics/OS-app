import { plan } from "./planner.js";
import type { AssistantRequest, AssistantResult } from "./types.js";

export * from "./types.js";
export { plan } from "./planner.js";

/**
 * AI assistant service (§10). By default it uses the built-in offline planner. When
 * a local-model service URL is configured (the Python `services/ai-py` running an
 * on-box model), it delegates there and falls back to the planner if it's
 * unavailable — so the assistant always works, online or off.
 */
export interface AssistantOptions {
  /** Base URL of the local AI model service; empty = built-in planner only. */
  modelUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class AssistantService {
  private readonly modelUrl?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: AssistantOptions = {}) {
    this.modelUrl = opts.modelUrl?.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  async assist(req: AssistantRequest): Promise<AssistantResult> {
    if (this.modelUrl) {
      const remote = await this.callModel(req);
      if (remote) return remote;
    }
    return plan(req);
  }

  private async callModel(req: AssistantRequest): Promise<AssistantResult | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.modelUrl}/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as AssistantResult;
    } catch {
      return null; // fall back to the offline planner
    } finally {
      clearTimeout(timer);
    }
  }
}
