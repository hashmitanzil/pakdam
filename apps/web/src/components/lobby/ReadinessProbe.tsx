'use client';
import { useEffect, useRef } from 'react';

/** Silent readiness probe — the headless remainder of the old
 *  ReadinessChecklist (cut from the lobby 2026-11-19, ShadowHunt trim).
 *
 *  Runs the equivalent checks ONCE on mount and renders NOTHING: no
 *  button, no progress, no text.
 *  - Location permission: Permissions API query where available.
 *  - Wake Lock: availability check only (no lock is taken here).
 *  - GPS quality: one foreground fix (warms the permission + fix so
 *    the match starts from a known location state).
 *  - Network: online/offline listeners.
 *
 *  Results are kept in a ref, never shown: nothing on this screen
 *  reports them. The old acknowledgement tick-box is gone with the
 *  checklist — it only wrote a localStorage flag and a room-log line
 *  (both cut), and the server's briefing record was never the
 *  tick-box: demo `toggleReady` sets briefingConfirmed, and live
 *  "I'm ready" sends briefing.confirm. */
export default function ReadinessProbe() {
  const ranRef = useRef(false);
  const resultRef = useRef({
    permission: 'unknown',
    wakeLockAvailable: false,
    gps: 'unknown',
    online: typeof navigator !== 'undefined' && navigator.onLine,
  });

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    const onOnline = () => { resultRef.current.online = true; };
    const onOffline = () => { resultRef.current.online = false; };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    // Location permission: query only — never prompts by itself.
    const nav = navigator as Navigator & { permissions?: { query: (q: { name: string }) => Promise<{ state: string }> } };
    if (nav.permissions?.query) {
      nav.permissions.query({ name: 'geolocation' }).then(
        (r) => { resultRef.current.permission = r.state; },
        () => { resultRef.current.permission = 'unknown'; },
      );
    }
    // Wake Lock: availability check only.
    const wnav = navigator as Navigator & { wakeLock?: unknown };
    resultRef.current.wakeLockAvailable = Boolean(wnav.wakeLock);
    // GPS quality: one foreground fix.
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        () => { resultRef.current.gps = 'pass'; },
        (err) => { resultRef.current.gps = err.code === 1 ? 'denied' : 'fail'; },
        { enableHighAccuracy: true, timeout: 15000 },
      );
    } else {
      resultRef.current.gps = 'fail';
    }
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return null;
}
