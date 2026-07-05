import type { SystemHealth } from "@supreme/contracts";
import { readFile, readdir, statfs } from "node:fs/promises";
import os from "node:os";

/**
 * Real host telemetry for the Installer Dashboard (§ Installer Dashboard). Every number here comes
 * from the operating system the hub actually runs on — Node's `os` module, `fs.statfs`, and (on
 * Linux) the thermal sysfs. Nothing is synthesised: a metric with no source on this platform is
 * OMITTED from the payload rather than reported as zero, so the UI can hide what it can't measure.
 * The response shape is the `SystemHealth` contract shared with the SDK.
 */

/** Aggregate busy + total CPU jiffies across all cores from one `os.cpus()` snapshot. */
function cpuTimes(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    busy += t.user + t.nice + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { busy, total };
}

/** CPU utilization % sampled over `ms`; null if the two snapshots don't advance (e.g. mocked timers). */
async function cpuUtilization(ms: number): Promise<number | null> {
  const a = cpuTimes();
  await new Promise((r) => setTimeout(r, ms));
  const b = cpuTimes();
  const dTotal = b.total - a.total;
  const dBusy = b.busy - a.busy;
  if (dTotal <= 0) return null;
  return Math.min(100, Math.max(0, (dBusy / dTotal) * 100));
}

/** First readable Linux thermal-zone temperature in °C, or null (not Linux / no sensor). */
async function cpuTemperatureC(): Promise<number | null> {
  try {
    const base = "/sys/class/thermal";
    const zones = (await readdir(base)).filter((z) => z.startsWith("thermal_zone"));
    for (const z of zones) {
      try {
        const raw = (await readFile(`${base}/${z}/temp`, "utf8")).trim();
        const milli = Number.parseInt(raw, 10);
        if (Number.isFinite(milli) && milli > 0) return Math.round((milli / 1000) * 10) / 10;
      } catch {
        // Try the next zone.
      }
    }
  } catch {
    // Not Linux, or sysfs not mounted — omit temperature.
  }
  return null;
}

/** Disk usage for `path` via statfs, or null if unavailable on this runtime/platform. */
async function storageFor(path: string): Promise<SystemHealth["storage"] | null> {
  try {
    const s = await statfs(path);
    const totalBytes = s.blocks * s.bsize;
    const freeBytes = s.bavail * s.bsize;
    const usedBytes = totalBytes - freeBytes;
    if (totalBytes <= 0) return null;
    return { totalBytes, usedBytes, freeBytes, usedPct: Math.round((usedBytes / totalBytes) * 1000) / 10 };
  } catch {
    return null;
  }
}

/**
 * Snapshot the host's real health. `dataPath` is the volume to report storage for (the hub's data
 * dir); defaults to the process cwd. `sampleMs` is the CPU sampling window.
 */
export async function collectSystemHealth(dataPath = process.cwd(), sampleMs = 120): Promise<SystemHealth> {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  const mem = process.memoryUsage();
  const [util, temp, storage] = await Promise.all([
    cpuUtilization(sampleMs),
    cpuTemperatureC(),
    storageFor(dataPath),
  ]);
  const load = os.loadavg();
  const cpus = os.cpus();

  return {
    uptimeSeconds: Math.round(process.uptime()),
    hostUptimeSeconds: Math.round(os.uptime()),
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model?.trim() ?? "unknown",
      loadAvg1: Math.round((load[0] ?? 0) * 100) / 100,
      loadAvg5: Math.round((load[1] ?? 0) * 100) / 100,
      loadAvg15: Math.round((load[2] ?? 0) * 100) / 100,
      ...(util !== null ? { utilizationPct: Math.round(util * 10) / 10 } : {}),
    },
    memory: {
      totalBytes,
      usedBytes,
      freeBytes,
      usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    },
    process: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
    ...(storage ? { storage } : {}),
    ...(temp !== null ? { temperatureC: temp } : {}),
  };
}
