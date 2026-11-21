/**
 * Foreground GPS — PROTOCOL-MAP §4.10 (R11).
 *
 * Foreground-only `watchPosition` (enableHighAccuracy, maximumAge 0,
 * timeout 15 s). Transient errors are swallowed; only permission-denied is
 * terminal. Live send rule: only fixes accurate to ±50 m or better are ever
 * sent (`ZONE_AUTO_CENTRE_MAX_ACCURACY_M`); a worse fix is never sent and
 * the UI says so plainly. Poor accuracy is warned, never treated as
 * cheating. Location stops when the tab hides.
 */
import {
  ZONE_AUTO_CENTRE_MAX_ACCURACY_M,
  canAutoCentreZone,
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
        message: 'GPS is too rough here — tap the map to place the zone.',
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
 * validation (deduped by timestamp); `onError` only for terminal
 * (permission-denied) errors — transient errors are swallowed silently.
 * The caller decides whether to send the fix (only ≤ ±50 m fixes are ever
 * sent — see `isFixSendable`).
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
      if (fix.timestampMs === lastTimestampMs) return; // exact duplicate
      lastTimestampMs = fix.timestampMs;
      const result = validateFix(fix);
      if (!result.ok) return; // bad shape / skew / stale — rejected, never sent
      onFix(fix);
    },
    (error) => {
      const mapped = toError(error);
      // Only permission-denied is terminal; the rest are transient.
      if (mapped.kind === 'permission-denied') onError?.(mapped);
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
