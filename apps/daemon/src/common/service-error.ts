/** Safe, user-facing failures at service boundaries. Never include vendor diagnostics. */
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message)
  }
}
