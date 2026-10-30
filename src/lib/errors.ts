/**
 * Typed download errors.
 *
 * Codes are stable for clients and tests; messages are safe to show to end
 * users (no internal paths, hostnames of internal services, or stack traces).
 */

export type DownloadErrorCode =
  | "INVALID_BODY"
  | "INVALID_FORMAT"
  | "EMPTY_URL"
  | "INVALID_URL"
  | "URL_TOO_LONG"
  | "UNSAFE_URL"
  | "UNSUPPORTED_SOURCE"
  | "SOURCE_NOT_PERMITTED"
  | "UPSTREAM_NOT_FOUND"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_ERROR"
  | "INVALID_CONTENT_TYPE"
  | "NOT_MEDIA"
  | "FORMAT_UNAVAILABLE"
  | "TOO_LARGE"
  | "CONVERSION_UNAVAILABLE"
  | "CONVERSION_FAILED"
  | "SERVER_BUSY"
  | "CANCELLED"
  | "INTERNAL";

const STATUS_BY_CODE: Record<DownloadErrorCode, number> = {
  INVALID_BODY: 400,
  INVALID_FORMAT: 400,
  EMPTY_URL: 400,
  INVALID_URL: 400,
  URL_TOO_LONG: 400,
  UNSAFE_URL: 400,
  UNSUPPORTED_SOURCE: 422,
  SOURCE_NOT_PERMITTED: 422,
  UPSTREAM_NOT_FOUND: 404,
  UPSTREAM_TIMEOUT: 504,
  UPSTREAM_ERROR: 502,
  INVALID_CONTENT_TYPE: 415,
  NOT_MEDIA: 415,
  FORMAT_UNAVAILABLE: 422,
  TOO_LARGE: 413,
  CONVERSION_UNAVAILABLE: 503,
  CONVERSION_FAILED: 502,
  SERVER_BUSY: 503,
  CANCELLED: 499,
  INTERNAL: 500,
};

export class DownloadError extends Error {
  readonly code: DownloadErrorCode;
  readonly status: number;
  /** Optional extra detail for server logs only; never sent to clients. */
  readonly diagnostic?: string;

  constructor(code: DownloadErrorCode, message: string, options: { cause?: unknown; diagnostic?: string } = {}) {
    super(message);
    this.name = "DownloadError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.diagnostic = options.diagnostic;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isDownloadError(error: unknown): error is DownloadError {
  return error instanceof DownloadError;
}
