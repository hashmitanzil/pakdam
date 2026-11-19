/**
 * PWA helpers — install prompt + service-worker registration.
 * The install prompt is a browser event; this module only captures it and
 * surfaces it to the UI. Nothing here is required to play.
 */

export interface InstallPrompt {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let deferredPrompt: InstallPrompt | null = null;
let promptListenerAttached = false;

/** Attach the `beforeinstallprompt` listener once; call early (e.g. layout). */
export function attachInstallPromptListener(): void {
  if (promptListenerAttached || typeof window === 'undefined') return;
  promptListenerAttached = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as unknown as InstallPrompt;
  });
}

/** True when an install prompt is currently available to show. */
export function isInstallPromptAvailable(): boolean {
  return deferredPrompt !== null;
}

/** Show the install prompt. Resolves false when no prompt is available. */
export async function showInstallPrompt(): Promise<boolean> {
  if (!deferredPrompt) return false;
  try {
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    return true;
  } catch {
    return false;
  } finally {
    deferredPrompt = null;
  }
}

/** Register the Serwist service worker (`/sw.js`). No-op when unsupported. */
export async function registerServiceWorker(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }
  try {
    await navigator.serviceWorker.register('/sw.js');
    return true;
  } catch {
    return false;
  }
}
