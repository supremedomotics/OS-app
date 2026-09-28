import net from "node:net";

/** Default RTSP ports to fall back-probe when a camera has no usable ONVIF response (§ STEP 3) —
 * configurable/extensible, never a hardcoded single value baked into the scan loop itself. */
export const DEFAULT_RTSP_PORTS = [554, 8554, 10554];

export interface TcpProbe {
  (host: string, port: number, timeoutMs: number): Promise<boolean>;
}

/** Real bare TCP-connect probe — "is anything listening here" only, never assumed to be RTSP by
 * itself (the identity layer only calls this a discovery signal; real confirmation happens during
 * commissioning's RTSP handshake, STEP 8). Injectable for tests. */
export const realTcpProbe: TcpProbe = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    try {
      sock.connect(port, host);
    } catch {
      finish(false);
    }
  });

export interface RtspPortProbeOptions {
  hosts: string[];
  ports?: number[];
  timeoutMs?: number;
  /** Max simultaneous in-flight TCP connects across the WHOLE scan (§ STEP 3 — "bounded,
   * rate-limited... No uncontrolled full port scans"). */
  concurrency?: number;
  probe?: TcpProbe;
  signal?: AbortSignal;
  onHit?: (host: string, port: number) => void;
}

/**
 * Bounded, concurrency-limited, cancellable sweep of `hosts × ports` using a plain TCP connect
 * (§ STEP 3/13). Returns `host -> responsive ports`. One slow/unreachable host never blocks the
 * rest — each probe has its own timeout and the pool keeps moving.
 */
export async function probeRtspPorts(opts: RtspPortProbeOptions): Promise<Map<string, number[]>> {
  const ports = opts.ports ?? DEFAULT_RTSP_PORTS;
  const timeoutMs = opts.timeoutMs ?? 400;
  const concurrency = Math.max(1, opts.concurrency ?? 32);
  const probe = opts.probe ?? realTcpProbe;
  const results = new Map<string, number[]>();

  const jobs: { host: string; port: number }[] = [];
  for (const host of opts.hosts) for (const port of ports) jobs.push({ host, port });

  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      if (opts.signal?.aborted) return;
      const job = jobs[cursor++]!;
      let ok = false;
      try {
        ok = await probe(job.host, job.port, timeoutMs);
      } catch {
        ok = false; // one malformed/exception-throwing probe never aborts the sweep (§ STEP 12)
      }
      if (ok) {
        const list = results.get(job.host) ?? [];
        list.push(job.port);
        results.set(job.host, list);
        opts.onHit?.(job.host, job.port);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}
