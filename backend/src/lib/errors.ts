/**
 * Shared error types mapped to HTTP status codes in `src/app.ts`.
 * Keeping them in one place avoids each service inventing its own mapping.
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Invalid or unusable input (HTTP 400). */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Authenticated-in-name-only authorization failure (HTTP 403). */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}
