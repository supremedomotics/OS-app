/**
 * @supreme/tools-loadtest — load / soak / chaos harness (§5, §15). Boots the real
 * gateway and drives it concurrently to measure latency, throughput, errors, memory,
 * and fault recovery.
 */
export {
  startHub,
  seedSession,
  runLoad,
  runLoadWindows,
  connectionStorm,
  faultBackend,
  wsBaseFrom,
  type Hub,
  type Session,
  type LoadOptions,
  type LoadResult,
} from "./harness.js";
export { Metrics, MemorySampler, type LoadSummary } from "./metrics.js";
