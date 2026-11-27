import type { ErrorCode, WcpError } from "./types";

/** HTTP status for each protocol error code (spec §11). */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  invalid_message: 400,
  unsupported_version: 400,
  unauthorized: 401,
  forbidden: 403,
  repo_not_found: 404,
  not_found: 404,
  session_expired: 410,
  base_ahead: 409,
  invalid_reference: 422,
  payload_too_large: 413,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
};

/** WebSocket close code for each protocol error that terminates a socket (4000 + HTTP status). */
export function closeCode(code: ErrorCode): number {
  return 4000 + ERROR_STATUS[code];
}

const RETRYABLE = new Set<ErrorCode>(["rate_limited", "internal", "unavailable"]);

export class WcpProtocolError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WcpProtocolError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.retryable = RETRYABLE.has(code);
    if (details) this.details = details;
  }
  toJSON(): WcpError {
    return {
      type: "error",
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/**
 * A `hello` naming an existing change that another agent created (spec §8.2, #17): a change is
 * bound to its creator, so a guessed id cannot join it, take over its open errors and dues, or
 * receive its owner notices. Same `403 forbidden` as a token binding mismatch (§3).
 */
export function changeOwnedError(change: string): WcpProtocolError {
  return new WcpProtocolError("forbidden", `change ${change} belongs to another agent; a hello may only join a change its own agent created`, { change });
}
