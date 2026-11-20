'use client';

/**
 * PWA bootstrap — runs once in the root layout (client component, so the
 * server layout stays a server component).
 *
 * - Registers the Serwist service worker (`/sw.js`).
 * - Captures the `beforeinstallprompt` event and shows a small "Install
 *   app" button while a prompt is available. Nothing here is required to
 *   play — install is an offer, never a gate.
 */
import { useEffect, useState } from 'react';
import {
  attachInstallPromptListener,
  isInstallPromptAvailable,
  registerServiceWorker,
  showInstallPrompt,
} from '@/lib/pwa';

export function PwaBootstrap() {
  const [installAvailable, setInstallAvailable] = useState(false);
  const [installDismissed, setInstallDismissed] = useState(false);

  useEffect(() => {
    void registerServiceWorker();
    attachInstallPromptListener();
    // `beforeinstallprompt` fires once per page load; the listener in
    // pwa.ts captures it, this one surfaces the button.
    const onPrompt = () => setInstallAvailable(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    // A prompt captured before this mounted (e.g. fast navigation) still counts.
    if (isInstallPromptAvailable()) setInstallAvailable(true);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  if (!installAvailable || installDismissed) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-[#26262B] bg-[#1E1E22] py-2 pl-4 pr-2 shadow-lg">
      <span className="text-[14px] font-semibold text-white">Install Pakdam</span>
      <button
        type="button"
        onClick={() => {
          void showInstallPrompt().then(() => setInstallAvailable(false));
        }}
        className="rounded-full bg-[#EF4444] px-3 py-1.5 text-[13px] font-bold text-white"
      >
        Install
      </button>
      <button
        type="button"
        aria-label="Dismiss install prompt"
        onClick={() => setInstallDismissed(true)}
        className="px-2 text-[15px] font-bold text-[#A1A1AA]"
      >
        ✕
      </button>
    </div>
  );
}
