import type { CapabilityKind, ProtocolKind } from "@supreme/domain-model";
import type { DiscoveredDevice } from "@supreme/integration-layer";
import type { IProtocolScanner } from "./index.js";

/**
 * Bridges to the Python commissioning service (FastAPI) which performs the actual
 * KNX/DALI/Modbus bus scans (blueprint §4 — protocol tooling is Python). The Node
 * orchestration calls it over loopback HTTP and normalizes results into the same
 * {@link DiscoveredDevice} shape the SIL produces, so commissioning is uniform.
 */
export interface HttpScannerOptions {
  protocol: ProtocolKind;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface ScanResponseItem {
  backend_id: string;
  name: string;
  capabilities: string[];
}

export class HttpProtocolScanner implements IProtocolScanner {
  readonly protocol: ProtocolKind;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: HttpScannerOptions) {
    this.protocol = opts.protocol;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 10000;
  }

  async scan(): Promise<DiscoveredDevice[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/scan/${this.protocol}`, {
        signal: ctrl.signal,
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { devices?: ScanResponseItem[] };
      return (body.devices ?? []).map((d) => ({
        backendId: d.backend_id,
        suggestedName: d.name,
        capabilities: d.capabilities as CapabilityKind[],
        raw: { protocol: this.protocol },
      }));
    } catch {
      // A scanner that's unreachable simply contributes no devices; commissioning
      // still proceeds with backend (SIL) discovery and other scanners.
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}
