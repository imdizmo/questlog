export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    public data?: unknown,
    /** Extra response headers (e.g. Retry-After). */
    public headers?: Record<string, string>,
  ) {
    super(code);
    this.name = 'AppError';
  }
}
