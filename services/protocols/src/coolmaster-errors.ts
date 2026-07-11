import type { CoolMasterTransportKind } from "./coolmaster-types.js";

/** Base class for every CoolMaster driver error — lets callers `instanceof
 * CoolMasterError` to distinguish driver failures from unrelated exceptions. */
export abstract class CoolMasterError extends Error {
  abstract readonly code: string;
  /** Whether retrying the same operation might succeed (network blip, gateway busy) vs
   * definitely won't (malformed command, unsupported feature). Drives coolmaster-polling
   * and coolmaster-connection's retry/backoff decisions. */
  abstract readonly retryable: boolean;

  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class CoolMasterConnectionError extends CoolMasterError {
  readonly code = "connection_error";
  readonly retryable = true;
  constructor(message: string, readonly transport: CoolMasterTransportKind, cause?: unknown) {
    super(message, cause);
  }
}

export class CoolMasterTimeoutError extends CoolMasterError {
  readonly code = "timeout";
  readonly retryable = true;
  constructor(message: string, readonly transport: CoolMasterTransportKind) {
    super(message);
  }
}

/** The gateway answered but rejected the request (bad exit code, unsupported command,
 * malformed args) — retrying the exact same request will not help. */
export class CoolMasterProtocolError extends CoolMasterError {
  readonly code = "protocol_error";
  readonly retryable = false;
  constructor(message: string, readonly raw: string) {
    super(message);
  }
}

/** A command this driver knows exists in the protocol but which this specific gateway/
 * firmware/unit didn't accept — surfaced distinctly from a generic protocol error so the
 * UI can say "not supported by this unit" rather than "something went wrong". */
export class CoolMasterUnsupportedCommandError extends CoolMasterError {
  readonly code = "unsupported_command";
  readonly retryable = false;
  constructor(readonly command: string, readonly uid?: string) {
    super(`coolmaster: "${command}" is not supported${uid ? ` for unit ${uid}` : ""}`);
  }
}

export class CoolMasterDeviceOfflineError extends CoolMasterError {
  readonly code = "device_offline";
  readonly retryable = true;
  constructor(readonly uid: string) {
    super(`coolmaster: unit ${uid} did not respond (offline or unreachable on its HVAC line)`);
  }
}

export class CoolMasterDiscoveryError extends CoolMasterError {
  readonly code = "discovery_error";
  readonly retryable = true;
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export class CoolMasterConfigError extends CoolMasterError {
  readonly code = "config_error";
  readonly retryable = false;
  constructor(message: string) {
    super(message);
  }
}

/** True for errors worth an automatic retry (per coolmaster-polling's command queue and
 * coolmaster-connection's reconnect logic); false for anything a retry can't fix. */
export function isRetryable(err: unknown): boolean {
  return err instanceof CoolMasterError ? err.retryable : true;
}
