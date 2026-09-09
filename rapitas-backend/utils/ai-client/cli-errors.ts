/**
 * cli-errors
 *
 * Error types shared between the auxiliary Claude CLI provider and its
 * process-cleanup module. Kept in a separate file so neither module needs to
 * import the other just to reference the error class (avoids a circular
 * import between claude-cli-provider.ts and aux-cli-cleanup.ts).
 */

/**
 * Thrown when the CLI path cannot serve a request (binary missing, not logged
 * in, non-zero exit, timeout, or a pending cleanup blocking new calls). Lets
 * the router / callers degrade gracefully instead of silently falling back to
 * the paid API.
 */
export class ClaudeCliUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCliUnavailableError';
  }
}
