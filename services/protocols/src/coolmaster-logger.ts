/**
 * Structured logging for the CoolMaster driver (§ Logging requirement — discovery,
 * commands, responses, polling, errors, recovery actions, all gated by debug mode). No
 * shared logging package exists elsewhere in this codebase (every other protocol driver
 * logs nothing at all, relying on thrown errors + state events) — this is a small,
 * self-contained logger scoped to this driver rather than a new cross-cutting dependency.
 */

export type CoolMasterLogLevel = "error" | "warn" | "info" | "debug";

export interface CoolMasterLogEntry {
  level: CoolMasterLogLevel;
  /** Which subsystem emitted this — "connection" | "discovery" | "command" | "poll" | … */
  scope: string;
  message: string;
  ts: string;
  detail?: Record<string, unknown>;
}

export type CoolMasterLogSink = (entry: CoolMasterLogEntry) => void;

/** The four-method shape returned by {@link CoolMasterLogger.child}, pre-bound to one scope. */
export interface CoolMasterScopedLogger {
  error(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  info(message: string, detail?: Record<string, unknown>): void;
  debug(message: string, detail?: Record<string, unknown>): void;
}

const LEVEL_RANK: Record<CoolMasterLogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Default sink: console, prefixed, JSON-stringified detail for greppability. Kept quiet
 * at "info" by default in production (debug=false) so normal operation isn't chatty. */
function consoleSink(entry: CoolMasterLogEntry): void {
  const line = `[coolmaster:${entry.scope}] ${entry.message}`;
  const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : "";
  if (entry.level === "error") console.error(line + detail);
  else if (entry.level === "warn") console.warn(line + detail);
  else console.log(line + detail);
}

export class CoolMasterLogger {
  private readonly sink: CoolMasterLogSink;
  private readonly maxLevel: CoolMasterLogLevel;

  constructor(opts: { debug?: boolean; sink?: CoolMasterLogSink } = {}) {
    this.maxLevel = opts.debug ? "debug" : "info";
    this.sink = opts.sink ?? consoleSink;
  }

  private emit(level: CoolMasterLogLevel, scope: string, message: string, detail?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] > LEVEL_RANK[this.maxLevel]) return;
    this.sink({ level, scope, message, ts: new Date().toISOString(), detail });
  }

  error(scope: string, message: string, detail?: Record<string, unknown>): void {
    this.emit("error", scope, message, detail);
  }
  warn(scope: string, message: string, detail?: Record<string, unknown>): void {
    this.emit("warn", scope, message, detail);
  }
  info(scope: string, message: string, detail?: Record<string, unknown>): void {
    this.emit("info", scope, message, detail);
  }
  debug(scope: string, message: string, detail?: Record<string, unknown>): void {
    this.emit("debug", scope, message, detail);
  }

  /** A logger scoped to a sub-namespace, e.g. `logger.child("discovery")`. */
  child(scope: string): CoolMasterScopedLogger {
    return {
      error: (message: string, detail?: Record<string, unknown>) => this.error(scope, message, detail),
      warn: (message: string, detail?: Record<string, unknown>) => this.warn(scope, message, detail),
      info: (message: string, detail?: Record<string, unknown>) => this.info(scope, message, detail),
      debug: (message: string, detail?: Record<string, unknown>) => this.debug(scope, message, detail),
    };
  }
}
