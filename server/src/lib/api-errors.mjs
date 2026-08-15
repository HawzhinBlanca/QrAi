/** Fixed public API failures; `detail` is server-side context and is never serialized. */
export class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    /** Server-side only. Never serialized into a response. */
    this.detail = detail;
  }
}

/** Axum-style request-extractor rejection with a text/plain response body. */
export class RejectionError extends ApiError {
  constructor(message, status) {
    super(message, status);
    this.name = "RejectionError";
    this.contentType = "text/plain; charset=utf-8";
  }
}

export const Unauthorized = (detail) =>
  new ApiError("missing or invalid authorization", 401, detail);
export const Forbidden = (detail) =>
  new ApiError("actor is not allowed to perform this action", 403, detail);
export const NotFound = (detail) => new ApiError("record not found", 404, detail);
