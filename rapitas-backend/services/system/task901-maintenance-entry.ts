/** Narrow Task901 maintenance switch; no fallback from a failed maintenance startup. */
export async function selectServerEntry(
  mode: string | undefined,
  loaders: { normal(): Promise<unknown>; maintenance(): Promise<unknown> },
): Promise<void> {
  if (mode === '1') {
    await loaders.maintenance();
    return;
  }
  if (mode !== undefined && mode !== '' && mode !== '0' && mode !== 'api')
    throw Error('Invalid Task901 maintenance mode');
  await loaders.normal();
}
