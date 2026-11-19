/**
 * Screen wake lock — best-effort, silent failure.
 * Requested on the play page as a convenience, never a guarantee.
 * Re-acquired on tab-visible (the lock is released when the tab hides).
 */
export interface WakeLockHandle {
  release(): Promise<void>;
  isHeld(): boolean;
}

let activeLock: WakeLockSentinel | null = null;
let visibleListenerAttached = false;

async function requestLock(): Promise<WakeLockSentinel | null> {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return null;
  try {
    const lock = await navigator.wakeLock.request('screen');
    activeLock = lock;
    lock.addEventListener('release', () => {
      if (activeLock === lock) activeLock = null;
    });
    return lock;
  } catch {
    // Best-effort: unsupported, denied, or the tab is hidden — silent.
    return null;
  }
}

/** Request the wake lock; resolves to a handle (held or not — never throws). */
export async function requestWakeLock(): Promise<WakeLockHandle> {
  await requestLock();
  if (!visibleListenerAttached && typeof document !== 'undefined') {
    visibleListenerAttached = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void requestLock();
    });
  }
  return {
    async release() {
      if (activeLock) {
        try {
          await activeLock.release();
        } catch {
          // Silent — the lock may already be released.
        }
        activeLock = null;
      }
    },
    isHeld() {
      return activeLock !== null;
    },
  };
}

/** True when the Wake Lock API exists on this device/browser. */
export function isWakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}
