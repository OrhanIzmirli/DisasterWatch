/** Typed failure of a news provider request (same shape as GdeltError). */
export class ProviderError extends Error {
  constructor(provider, message, kind, status = null) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.kind = kind; // "timeout" | "rate-limit" | "auth" | "http" | "non-json" | "network" | "backoff"
    this.status = status;
  }
}
