/** An intentional stop detected before an asynchronous execution can continue. */
export class ExecutionCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionCancelledError';
  }
}
