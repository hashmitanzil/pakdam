'use client';

/**
 * ReadinessProbe — headless silent readiness checks (SCRAM-SPEC §7.3).
 *
 * The 5 readiness checks run in the background; there is no checklist,
 * no warning + checkbox, no Safety block, no Lobby radio, no Role
 * preview, no Host check-in, no event log on the lobby screen. This
 * component renders nothing. Checks run once on mount:
 * permission query, wake-lock support check, one foreground GPS fix,
 * online/offline listeners. Nothing here blocks play or shows UI —
 * a failed check only means the fix/location stays unknown.
 */
import { useEffect } from 'react';
import { getCurrentFix } from '../../lib/geolocation';

export function ReadinessProbe() {
  useEffect(() => {
    // 1. Permission state (query only — never prompts from here).
    try {
      const permissions = (navigator as Navigator & {
        permissions?: { query: (o: { name: string }) => Promise<{ state: string }> };
      }).permissions;
      void permissions?.query({ name: 'geolocation' }).catch(() => undefined);
    } catch {
      // Permissions API unavailable — the GPS fix below still runs.
    }
    // 2. Wake-lock support check (the play screen requests the lock).
    void ('wakeLock' in navigator);
    // 3. One foreground GPS fix (best-effort; never sent anywhere).
    void getCurrentFix().catch(() => undefined);
    // 4 + 5. Online / offline listeners (connectivity is the socket's
    // job to report; these only keep the listeners attached).
    const onOnline = (): void => undefined;
    const onOffline = (): void => undefined;
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);
  return null;
}
