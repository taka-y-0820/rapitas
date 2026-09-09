let pending: Promise<unknown> = Promise.resolve();

/**
 * Do not spawn while another runtime's temporary port listener is open.
 * On Windows/Bun a concurrent child can retain that listener's socket and
 * prevent the intended server from binding it. Hold only through spawn,
 * never through readiness checks or the lifetime of the launched process.
 */
export function withRuntimeLaunchLock<T>(launch: () => Promise<T>): Promise<T> {
  const result = pending.then(launch);
  pending = result.catch(() => {});
  return result;
}
