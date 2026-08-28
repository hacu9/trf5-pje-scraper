/** Error raised when a request keeps failing after every retry is spent. */
export class HttpFailure extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string,
    readonly attempts: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'HttpFailure';
  }
}

/** Error raised when a response is technically fine but is not what we asked for. */
export class ContentError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly contentType: string | null,
  ) {
    super(message);
    this.name = 'ContentError';
  }
}
