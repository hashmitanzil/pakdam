/** Screen Wake Lock — a convenience while foreground, NEVER a guarantee.
 *  The browser releases it when the document becomes inactive. */
export async function requestWakeLock(): Promise<{ release: () => void } | null> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } };
    if (!nav.wakeLock) return null;
    const lock = await nav.wakeLock.request('screen');
    return { release: () => { void lock.release(); } };
  } catch { return null; }
}
