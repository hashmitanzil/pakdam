/**
 * Foreground GPS — PROTOCOL-MAP §4.10 (R11).
 *
 * Foreground-only `watchPosition` (enableHighAccuracy, maximumAge 0,
 * timeout 15 s). Permission-denied (and position-unavailable, v28)
 * is terminal/visible; a timeout (v30) is surfaced too — the watch
 * stays alive, but a GPS chip that has searched 15 s with nothing
 * must not be silent. Live send rule (B1, v18 — liveness decoupled
 * from usability): a fix is SENT whenever it is within the server
 * validity bound (±1000 m), so a poor-but-present GPS still stamps
 * `lastFixAt`; only fixes accurate to ±50 m are USABLE for gameplay,
 * and that gate lives server-side. Poor accuracy is warned, never
 * treated as cheating. (Note the split: `isFixSendable` in
 * @pakdam/shared is the ±50 m USABILITY / quality bar — the lobby
 * uses it as its fix-quality bar — while the play page sends up to
 * ±1000 m via MAX_FIX_ACCURACY_METERS. The two are different gates
 * on purpose; do not "fix" one to match the other without a founder
 * call — see the v30 report.)
 *
 * v28 (Diya F13): the header used to claim "Location stops when the
 * tab hides" — `watchLocation` itself never implemented any such
 * pause, and no caller paused it either, so a phone left on the play
 * screen kept sending ~1 fix/s all night. The pause lives with the
 * CALLER now: the play page stops the watcher on terminal phase and
 * when the tab hides, and restarts it on visible (see play/page.tsx
 * — `shouldWatchLocation`). This helper stays a plain watch: it
 * starts, delivers validated fixes, and stops on `stop()`.
 */
import {
  ZONE_AUTO_CENTRE_MAX_ACCURACY_M,
  canAutoCentreZone,
  haversineMeters,
  isFixSendable,
  locationFreshnessLabel,
  validateFix,
  type LocationFix,
} from '@pakdam/shared';

export type { LocationFix };
export { locationFreshnessLabel };

export type GeolocationErrorKind =
  | 'permission-denied'
  | 'position-unavailable'
  | 'timeout'
  | 'unsupported';

export interface GeolocationError {
  kind: GeolocationErrorKind;
  message: string;
}

const WATCH_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 15_000,
};

function toFix(position: GeolocationPosition): LocationFix {
  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracyMeters: position.coords.accuracy,
    timestampMs: position.timestamp,
  };
}

function toError(error: GeolocationPositionError): GeolocationError {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return {
        kind: 'permission-denied',
        message:
          'Location is off — allow it in your browser settings, then tap the map to place the zone.',
      };
    case error.POSITION_UNAVAILABLE:
      return {
        kind: 'position-unavailable',
        message: 'GPS is unavailable right now — tap the map to place the zone.',
      };
    default:
      return {
        kind: 'timeout',
        message: 'GPS is too rough here — tap the map to place the zone.',
      };
  }
}

export interface WatchHandle {
  stop(): void;
}

/**
 * Foreground-only watch. Calls `onFix` for every fresh fix that passes
 * validation (deduped by timestamp); `onError` for permission-denied
 * (the watch is dead: the OS will not call back again until permission
 * is re-granted and the watch is recreated), position-unavailable
 * (v28, Diya F16: GPS off / unavailable is a VISIBLE state for the
 * player, not silence — the old code swallowed it and the dot froze
 * with no explanation), and timeout (v30: a 15 s search with no fix
 * is VISIBLE too — the watch stays alive and keeps trying, so a
 * timeout is a notice, never a suspension or a dot clear; the caller
 * decides that). The caller decides whether to send the fix (only
 * ≤ ±1000 m fixes are ever sent — see the play page's
 * MAX_FIX_ACCURACY_METERS check, NOT `isFixSendable`, which is the
 * ±50 m usability bar). The caller ALSO owns pausing: this helper
 * never pauses on hide itself (v28, Diya F13) — the play page
 * stops/starts the watch.
 */
export function watchLocation(
  onFix: (fix: LocationFix) => void,
  onError?: (error: GeolocationError) => void,
): WatchHandle | null {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    onError?.({
      kind: 'unsupported',
      message: 'This device has no GPS — tap the map to place the zone.',
    });
    return null;
  }
  let lastTimestampMs = -1;
  const watchId = navigator.geolocation.watchPosition(
    (position) => {
      const fix = toFix(position);
      // Dedupe by timestamp — but ONLY for accepted fixes (v30): the
      // old code stamped `lastTimestampMs` BEFORE `validateFix`, so a
      // REJECTED fix (> ±1000 m, stale, skewed) poisoned the dedupe
      // and a valid fix arriving in the same millisecond was dropped
      // with it. A rejected fix must not eat a later valid one.
      if (fix.timestampMs === lastTimestampMs) return; // exact duplicate
      const result = validateFix(fix);
      if (!result.ok) return; // bad shape / skew / stale — rejected, never sent
      lastTimestampMs = fix.timestampMs;
      onFix(fix);
    },
    (error) => {
      const mapped = toError(error);
      // Permission-denied is terminal (the watch is dead); so is a
      // reported position-unavailable (GPS off / no signal — the
      // player must see it, not silence). A timeout is surfaced too
      // (v30): the watch stays alive, but 15 s of searching with no
      // fix is a visible state, not silence — the old code swallowed
      // it, so a phone whose GPS chip never acquires (indoors, cold
      // start) showed nothing at all from the error path.
      if (
        mapped.kind === 'permission-denied' ||
        mapped.kind === 'position-unavailable' ||
        mapped.kind === 'timeout'
      ) {
        onError?.(mapped);
      }
    },
    WATCH_OPTIONS,
  );
  return {
    stop() {
      navigator.geolocation.clearWatch(watchId);
    },
  };
}

/**
 * One-shot fix, staged chain (PROTOCOL-MAP §4.10): 12 s high-accuracy
 * watch → 10 s high-accuracy one-shot → 15 s low-accuracy one-shot → 8 s
 * cached one-shot (maximumAge 5 min). 45 s global deadline. Returns the
 * best fix within ±50 m, or throws a plain-words timeout.
 */
export async function getCurrentFix(): Promise<LocationFix> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    throw new Error('This device has no GPS — tap the map to place the zone.');
  }
  const deadlineMs = Date.now() + 45_000;
  // Holder object, not a plain `let`: `best` is assigned inside geolocation
  // callbacks, and TS narrows a closure-assigned `let` to `never` after an
  // `await` (it cannot see the callback assignments). A property read is
  // not narrowed that way, so the staged checks below typecheck.
  const bestHolder: { fix: LocationFix | null } = { fix: null };

  const oneShot = (options: PositionOptions, timeoutMs: number): Promise<LocationFix | null> =>
    new Promise((resolve) => {
      const timer = window.setTimeout(() => resolve(null), timeoutMs);
      navigator.geolocation.getCurrentPosition(
        (position) => {
          window.clearTimeout(timer);
          const fix = toFix(position);
          const result = validateFix(fix);
          resolve(result.ok ? fix : null);
        },
        () => {
          window.clearTimeout(timer);
          resolve(null);
        },
        options,
      );
    });

  const consider = (fix: LocationFix | null) => {
    if (!fix) return;
    if (bestHolder.fix === null || fix.accuracyMeters < bestHolder.fix.accuracyMeters) {
      bestHolder.fix = fix;
    }
  };

  // Stage 1: 12 s high-accuracy watch — take the first good fix, else the best.
  await new Promise<void>((resolve) => {
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const fix = toFix(position);
        consider(validateFix(fix).ok ? fix : null);
        if (
          bestHolder.fix !== null &&
          bestHolder.fix.accuracyMeters <= ZONE_AUTO_CENTRE_MAX_ACCURACY_M
        ) {
          navigator.geolocation.clearWatch(watchId);
          resolve();
        }
      },
      () => undefined,
      WATCH_OPTIONS,
    );
    window.setTimeout(() => {
      navigator.geolocation.clearWatch(watchId);
      resolve();
    }, 12_000);
  });
  if (
    bestHolder.fix !== null &&
    bestHolder.fix.accuracyMeters <= ZONE_AUTO_CENTRE_MAX_ACCURACY_M
  ) {
    return bestHolder.fix;
  }

  // Stage 2: 10 s high-accuracy one-shot.
  consider(await oneShot({ enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 }, 10_000));
  if (
    bestHolder.fix !== null &&
    bestHolder.fix.accuracyMeters <= ZONE_AUTO_CENTRE_MAX_ACCURACY_M
  ) {
    return bestHolder.fix;
  }

  // Stage 3: 15 s low-accuracy one-shot.
  consider(await oneShot({ enableHighAccuracy: false, maximumAge: 0, timeout: 15_000 }, 15_000));
  if (
    bestHolder.fix !== null &&
    bestHolder.fix.accuracyMeters <= ZONE_AUTO_CENTRE_MAX_ACCURACY_M
  ) {
    return bestHolder.fix;
  }

  // Stage 4: 8 s cached one-shot (maximumAge 5 min).
  consider(
    await oneShot({ enableHighAccuracy: false, maximumAge: 300_000, timeout: 8_000 }, 8_000),
  );
  if (
    bestHolder.fix !== null &&
    bestHolder.fix.accuracyMeters <= ZONE_AUTO_CENTRE_MAX_ACCURACY_M
  ) {
    return bestHolder.fix;
  }
  if (Date.now() >= deadlineMs && bestHolder.fix === null) {
    throw new Error('GPS is too rough here — tap the map to place the zone.');
  }
  if (bestHolder.fix !== null) return bestHolder.fix;
  throw new Error('GPS is too rough here — tap the map to place the zone.');
}

/**
 * GPS send gate — performance roadmap R7 (P1, client side).
 *
 * Send at most 1 fix / 5 s OR on ≥ 10 m movement, whichever first.
 * The movement leg is LOAD-BEARING (anti-cheat burst evidence): a
 * 240 m burst triggers an immediate send, preserving the burst the
 * server's speed/teleport checks need — a pure 5 s time gate would
 * destroy sub-5 s burst-duration resolution and out-and-back
 * teleports. Do NOT ship a pure time gate. Stationary players still
 * send a periodic fix (the 5 s leg) so `lastFixAt` stays fresh and
 * the no-fix ejection never fires for a player who is simply standing
 * still. The server 1 s throttle is untouched (Kabir owns it; it
 * stays) — this gate only cuts what the client sends.
 *
 * Meter math (conservative reading — the cap counts ACTUAL WS
 * messages, ~65,200 requests per 30-player 30-min game): the fix
 * stream is the biggest leg (~30,000–50,000/game at ~1 fix/s). At the
 * 5 s ceiling a game sends ≤ 10,800 fixes; moving players send more
 * (a runner at 3 m/s crosses 10 m every ~3 s), so the real saving is
 * < 5× — roughly 15,000–25,000 fixes/game. The gate never delays a
 * fix the display needs: display throttling is separate (play page).
 */
export const GPS_SEND_MIN_INTERVAL_MS = 5_000;
export const GPS_SEND_MIN_MOVEMENT_M = 10;

/** Last fix actually sent, for the gate below. */
export interface LastSentFix {
  fix: LocationFix;
  sentAtMs: number;
}

/**
 * May this fix be sent now? First fix always sends; afterwards send
 * when ≥ 5 s passed since the last sent fix OR the player moved
 * ≥ 10 m since it — whichever first. Pure function (unit-tested).
 */
export function shouldSendFix(
  fix: LocationFix,
  lastSent: LastSentFix | null,
  nowMs: number,
): boolean {
  if (lastSent === null) return true;
  if (nowMs - lastSent.sentAtMs >= GPS_SEND_MIN_INTERVAL_MS) return true;
  return (
    haversineMeters(
      { lat: lastSent.fix.lat, lng: lastSent.fix.lng },
      { lat: fix.lat, lng: fix.lng },
    ) >= GPS_SEND_MIN_MOVEMENT_M
  );
}

/**
 * May this fix be USED for gameplay (zone / auto-centre / catch
 * proximity)? Same ±50 m rule as auto-centring. This is NOT the send
 * gate any more (B1, v18 fix round): liveness sends go up to
 * MAX_FIX_ACCURACY_METERS (±1000 m) — see the play page — so a
 * poor-but-present GPS still stamps `lastFixAt`. The lobby still uses
 * this as its fix-quality bar.
 */
export function isFixSendableToServer(fix: LocationFix): boolean {
  return isFixSendable(fix);
}

/** May the zone auto-centre on this fix? Never worse than ±50 m. */
export function canZoneAutoCentreOn(fix: LocationFix): boolean {
  return canAutoCentreZone(fix);
}
