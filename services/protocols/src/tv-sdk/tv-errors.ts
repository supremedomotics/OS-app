/** (§ TV SDK Core) Error taxonomy for the TV platform SDK — mirrors coolmaster-errors.ts's
 * shape (abstract base + `retryable` flag driving queue/reconnect decisions) so this
 * fleet's error-handling conventions stay consistent across drivers. */
export abstract class TvError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class TvConnectionError extends TvError {
  readonly code = "connection_error";
  readonly retryable = true;
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export class TvTimeoutError extends TvError {
  readonly code = "timeout";
  readonly retryable = true;
}

export class TvPairingRequiredError extends TvError {
  readonly code = "pairing_required";
  readonly retryable = false;
}

export class TvAuthenticationError extends TvError {
  readonly code = "authentication_error";
  readonly retryable = false;
}

/** A command the SDK models but this device's active transport doesn't support (e.g. a
 * key with no ADB equivalent) — never a generic failure. */
export class TvUnsupportedCommandError extends TvError {
  readonly code = "unsupported_command";
  readonly retryable = false;
  constructor(readonly command: string, readonly deviceId?: string) {
    super(`tv: "${command}" is not supported${deviceId ? ` for device ${deviceId}` : ""}`);
  }
}

export class TvConfigError extends TvError {
  readonly code = "config_error";
  readonly retryable = false;
}

/** True for errors worth an automatic retry/reconnect; false for anything a retry can't
 * fix (bad pairing, unsupported command, config error). */
export function isTvErrorRetryable(err: unknown): boolean {
  return err instanceof TvError ? err.retryable : true;
}
