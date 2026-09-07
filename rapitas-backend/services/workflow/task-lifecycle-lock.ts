/** Serialize main-server task lifecycle decisions across scheduler ticks and answers. */
const tails = new Map<number, Promise<void>>();

export async function withTaskLifecycleLock<T>(
  taskId: number,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(taskId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(taskId) === current) tails.delete(taskId);
  }
}
