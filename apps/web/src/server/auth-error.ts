export class AuthError extends Error {
  constructor(
    public readonly status = 403,
    public readonly reason?: string,
  ) {
    super("Request denied");
  }
}
