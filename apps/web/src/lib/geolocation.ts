/** Foreground-only Geolocation wrapper (HNT-034/035). watchPosition delivers
 *  updates ONLY while the document is fully active and visible (W3C).
 *  When the tab is hidden / phone locks, updates stop — the player is then
 *  "location unknown — suspended", never shown as live.
 *
 *  Accuracy rule (founder bug fix, 2026-11-17): the app NEVER centres a
 *  zone on a coarse / cached / IP-based fix. A one-shot "Use my location"
 *  waits for a GOOD fix (accuracy within CALIBRATION_OPEN.accuracyGoodMaxM,
 *  10 m) and says plainly "GPS accuracy ±X m". Indoors the browser's
 *  provider returns a network/IP fix — right area, wrong spot, often the
 *  same fixed spot, identical on every tap — so accepting the first fix made
 *  the button look dead: the map stayed on the same wrong spot. That fix
 *  is now rejected (or, at the end of the chain, a fix accurate to ±50 m or
 *  better is accepted — the founder's auto-centre limit,
 *  ZONE_AUTO_CENTRE_MAX_ACCURACY_M — still a real GPS/WiFi fix, never a
 *  city-level one) and the rejection states how far off GPS is, with
 *  tap-to-place / drag-the-pin as the fallback.
 *
 *  Staged chain (founder steer, 2026-11-17 — "try ALL types of approach",
 *  never leave the user stuck on "Finding your location…"):
 *  getCurrentFix tries, in order, (0) the permission state — denied
 *  skips GPS entirely and goes straight to the manual pin; (1) a
 *  high-accuracy watch (12 s); (2) a high-accuracy one-shot (10 s);
 *  (3) a low-accuracy one-shot (15 s); (4) a cached one-shot
 *  (maximumAge 5 min, 8 s). Each stage has its own timeout, so a
 *  hanging method is abandoned and the next takes over automatically;
 *  a 45 s global deadline settles with the best fix seen (if within
 *  ±50 m) or the plain-language timeout help. If consecutive stages
 *  return the IDENTICAL fix (same lat/lng/accuracy — a static
 *  provider with one fix to give, e.g. a mocked or network fix),
 *  the chain short-circuits: later stages would return the same fix,
 *  so it settles immediately instead of burning the full 45 s.
 *  maximumAge is 0 for stages 1–3 (no cached fix); stage 4 is the
 *  ONLY stage that accepts a cached fix, and only within ±50 m —
 *  and its `at` timestamp is the fix's own time, so freshness labels
 *  show its true age. retryLocation() force-resets every busy flag
 *  (attempt token, watch id, best fix) and restarts the chain from
 *  the permission check. If the browser blocks geolocation entirely
 *  (permission denied, or the prompt never appears and every stage
 *  times out), the chain rejects with plain language and the UI
 *  makes tap-the-map the primary path — the game stays playable
 *  with zero GPS. */
import { classifyAccuracy, CALIBRATION_OPEN, ZONE_AUTO_CENTRE_MAX_ACCURACY_M } from '@pakdam/shared';
export interface ForegroundFix { lat: number; lng: number; accuracyMeters: number; quality: 'good' | 'fair' | 'poor'; at: string }
/** How to turn location back on, shown verbatim when permission is
 *  denied (founder decision, 2026-11-17 — the old "enable it in your
 *  browser settings" told the player nothing useful). */
export const LOCATION_DENIED_HELP =
  'Location unavailable — location permission is denied. To turn it on: Android — Settings → Apps → Pakdam → Permissions → Location → "Allow while using the app", and switch Precise location on. iPhone — Settings → Pakdam → Location → "While Using the App", and switch Precise Location on. Then try again — or tap the map to place the zone where you are standing.';

/** A fix is good enough to centre a zone on: within the "good" tier
 *  (CALIBRATION_OPEN.accuracyGoodMaxM, 10 m). */
export function isGoodFix(f: ForegroundFix): boolean {
  return f.accuracyMeters <= CALIBRATION_OPEN.accuracyGoodMaxM;
}

/** Precise vs Approximate location, for the game UI (D-M3).
 *  Honest limit, stated plainly: a web page CANNOT read the phone's
 *  Precise/Approximate location toggle — the browser exposes no API
 *  for it (navigator.permissions only reports granted/prompt/denied).
 *  So the mode shown is derived from the fix the phone actually
 *  delivered, on the accuracy tiers this app already uses: a good
 *  (≤10 m) or fair (≤25 m) fix is a real GPS/WiFi fix — Precise
 *  location; a coarser fix (>25 m) is a network / cell / IP-level
 *  fix — Approximate location. No fix yet means the mode is unknown,
 *  never guessed. The label is plain words, never coordinates. */
export type LocationPrecision = 'precise' | 'approximate' | 'unknown';
export function locationPrecision(accuracyMeters: number | null | undefined): LocationPrecision {
  if (accuracyMeters == null || !Number.isFinite(accuracyMeters) || accuracyMeters <= 0) return 'unknown';
  return accuracyMeters <= CALIBRATION_OPEN.accuracyFairMaxM ? 'precise' : 'approximate';
}
/** Plain-words UI label for a fix's precision. */
export function locationPrecisionLabel(accuracyMeters: number | null | undefined): string {
  const p = locationPrecision(accuracyMeters);
  if (p === 'precise') return 'Precise location';
  if (p === 'approximate') return 'Approximate location';
  return 'Location not shared yet';
}

export function watchForegroundLocation(cb: (f: ForegroundFix) => void, onError: (msg: string) => void): () => void {
  if (!('geolocation' in navigator)) { onError('Geolocation is not available in this browser.'); return () => {}; }
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      const f: ForegroundFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyMeters: pos.coords.accuracy, quality: classifyAccuracy(pos.coords.accuracy, CALIBRATION_OPEN), at: fixTimestamp(pos.timestamp) };
      latestWatchedFix = f;
      cb(f);
    },
    // Transient errors (POSITION_UNAVAILABLE / TIMEOUT) do NOT kill
    // the watch — per spec the watcher keeps running and a later
    // fix still arrives — so they are swallowed here: forwarding
    // them would set a stuck error in the caller (the play page
    // passes setLocError straight through and nothing clears it
    // when a later good fix arrives), making live play look broken
    // after one indoor stall. Only PERMISSION_DENIED (code 1) is
    // terminal for the watch and is reported, with the plain-words
    // enable steps. The no-fix-yet UI ("Finding your location…")
    // covers the waiting state, and getCurrentFix still reports
    // its own timeout with full help when the host taps
    // "Use my location".
    (err) => { if (err.code === 1) onError(LOCATION_DENIED_HELP); },
    // maximumAge 0: the watcher delivers fresh fixes as GPS locks and
    // refines; a cached fix must never be shown as live.
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
  );
  return () => { latestWatchedFix = null; navigator.geolocation.clearWatch(id); };
}

/** The active watcher's latest fix, if any. One-shot requests reuse
 *  it ONLY when it is good and fresh (see getCurrentFix): an active
 *  high-accuracy watcher starves fresh getCurrentPosition calls — under
 *  Playwright's static geolocation mock the one-shot never resolves while
 *  the watcher is pending, and on a real phone the watcher's fix is the
 *  freshest one available. Reusing it is the authorised fix-round change
 *  (2026-11-17): Refresh re-sends the latest known fix instead of taking
 *  a fresh one-shot that never returns. The fix's own `at` timestamp is
 *  kept, so freshness labels still show its true age; the send time is
 *  recorded separately by the caller. Cleared when the watcher stops, so
 *  a stale fix is never reused after the watcher is gone. */
let latestWatchedFix: ForegroundFix | null = null;

/** A reused watcher fix must be good AND fresh: a stale or coarse fix
 *  from an earlier spot must never centre a zone. Fresh = under 30 s
 *  old; good = within the good accuracy tier. */
const REUSED_FIX_MAX_AGE_MS = 30_000;

/** One-shot fix for host setup ("Use my location"). Waits for a GOOD
 *  fix (accuracy within the good tier) so the zone is centred on the
 *  host's real spot, never on a coarse network/IP fix. Resolves with a
 *  foreground fix; rejects with a plain-language message the UI shows
 *  as-is. Permission denied is the common case — the caller must offer
 *  tap-to-place on the map as the fallback, never a hardcoded centre.
 *  A 20 s watchdog guards the case where the browser's geolocation
 *  provider never calls back at all (observed in headless Chromium:
 *  no grant + no mock = the denied callback never arrives, and the
 *  button would spin on "Finding your location…" forever). If no good
 *  fix arrives by the watchdog, the best fix seen is accepted only
 *  when it is accurate to ±50 m or better (the founder's auto-centre
 *  limit); a coarser fix is rejected with coarseFixMessage — how far
 *  off GPS is, in km when it is kilometres — so the host places the
 *  pin by hand instead of getting a zone kilometres from where they
 *  stand. `onProgress` reports the best accuracy seen so far while
 *  the fix refines, so the UI shows live progress, never a static
 *  spinner. */
/** The fix's own timestamp, as an ISO string — so a cached fix
 *  reports its TRUE age (freshness labels must not call a 4-minute-old
 *  fix "just now"). Falls back to now when the browser gives no
 *  usable timestamp (0, missing, or absurdly far in the future). */
function fixTimestamp(ts: number): string {
  const now = Date.now();
  const sane = Number.isFinite(ts) && ts > 0 && ts <= now + 5 * 60 * 1000;
  return new Date(sane ? ts : now).toISOString();
}

/** Permission state for geolocation, via navigator.permissions.
 *  'unknown' when the API is absent, errors, or does not answer
 *  within 2 s — the chain proceeds as if the state were 'prompt'
 *  (asking is still worth trying). A 'denied' answer is trusted:
 *  the chain skips GPS entirely instead of spinning. */
export async function checkLocationPermission(): Promise<'granted' | 'prompt' | 'denied' | 'unknown'> {
  try {
    const perms = (navigator as Navigator & { permissions?: { query(o: { name: string }): Promise<{ state: string }> } }).permissions;
    if (!perms?.query) return 'unknown';
    const result = await Promise.race([
      perms.query({ name: 'geolocation' }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    if (!result) return 'unknown';
    return result.state === 'granted' || result.state === 'prompt' || result.state === 'denied' ? result.state : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The best (most accurate) fix the latest attempt saw, even when it
 *  was too coarse to centre a zone on. The UI reads it after a
 *  rejection and offers "Use this approximate spot" — the host may
 *  CHOOSE the coarse fix as a hand-placed pin (labelled approximate),
 *  but it is never applied silently. Cleared by retryLocation(). */
let lastBestCoarse: ForegroundFix | null = null;
export function getBestCoarseFix(): ForegroundFix | null {
  return lastBestCoarse;
}

/** Global deadline for one chain run: every stage has its own
 *  timeout, and this deadline is the backstop — after 45 s the chain
 *  settles with the best fix seen (if within ±50 m) or the timeout
 *  help, so "Finding your location…" can never spin forever. */
const CHAIN_DEADLINE_MS = 45_000;
/** A cached fix is accepted only when it is at most this old. */
const CACHED_FIX_MAX_AGE_MS = 5 * 60 * 1000;

export const LOCATION_TIMEOUT_HELP =
  'Location unavailable. The phone did not return a location — every GPS method was tried (high-accuracy watch, one-shot GPS, standard GPS, and the last known location). Location may be off, or the phone may have no GPS fix indoors. Android — Settings → Apps → Pakdam → Permissions → Location → "Allow while using the app", and switch Precise location on. iPhone — Settings → Pakdam → Location → "While Using the App", and switch Precise Location on. Then try again — or tap the map to place the zone where you are standing.';
/** Plain-language rejection for a fix too coarse to centre a zone on
 *  (founder rule, 2026-11-17 — never auto-centre on worse than ±50 m):
 *  states how far off GPS is, in km when it is kilometres, and tells
 *  the host to place the pin by hand instead. */
export function coarseFixMessage(accuracyM: number): string {
  const off = accuracyM >= 1000
    ? `GPS is off by ~${(accuracyM / 1000).toFixed(1)} km`
    : `GPS accuracy is still ±${Math.round(accuracyM)} m — every GPS method was tried`;
  return `${off} — too coarse to centre the zone on (a zone needs a fix accurate to ±${ZONE_AUTO_CENTRE_MAX_ACCURACY_M} m or better). Drag the pin to your exact spot: tap the map to place the zone where you are standing, or drag the centre pin.`;
}

export type LocationProgress = (bestAccuracyM: number | null, stage?: string) => void;

/** Attempt token: every getCurrentFix / retryLocation call bumps it,
 *  and a superseded attempt's callbacks become no-ops — so a second
 *  "Use my location" tap (or a Retry) cancels the first attempt
 *  instead of stacking two chains that fight over the UI. */
let attemptId = 0;

export function getCurrentFix(onProgress?: LocationProgress): Promise<ForegroundFix> {
  return runFixChain(onProgress);
}

/** Manual retry: force-resets every busy flag — the attempt token
 *  (cancelling any in-flight chain), the watch id, the best fix —
 *  and restarts the chain from the permission check. The UI's
 *  "Retry location" button calls this; it never reuses a stale
 *  attempt's state. */
export function retryLocation(onProgress?: LocationProgress): Promise<ForegroundFix> {
  lastBestCoarse = null;
  return runFixChain(onProgress);
}

function runFixChain(onProgress?: LocationProgress): Promise<ForegroundFix> {
  // Reuse the active watcher's latest fix ONLY when it is good and
  // fresh (see REUSED_FIX_MAX_AGE_MS): a stale or coarse fix from an
  // earlier spot must never centre a zone. No watcher is active on
  // the host-setup screens, so those callers still get a fresh chain.
  if (latestWatchedFix) {
    const ageMs = Date.now() - new Date(latestWatchedFix.at).getTime();
    if (ageMs <= REUSED_FIX_MAX_AGE_MS && isGoodFix(latestWatchedFix)) {
      return Promise.resolve({ ...latestWatchedFix });
    }
  }
  const id = ++attemptId;
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) { reject('Geolocation is not available in this browser — tap the map to place the zone instead.'); return; }
    let settled = false;
    let best: ForegroundFix | null = null;
    let watchId: number | null = null;
    let stage = '';
    /** The last fix delivered by any stage, for the static-provider
     *  short-circuit: when two consecutive stages return the
     *  IDENTICAL fix (same lat/lng/accuracy), the provider has one
     *  fix to give and later stages would return the same one. */
    let lastDelivered: ForegroundFix | null = null;
    let identicalStreak = 0;
    const alive = () => !settled && id === attemptId;
    const cleanup = () => {
      if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    };
    const finish = (f: ForegroundFix) => {
      if (!alive()) return;
      settled = true;
      cleanup();
      clearTimeout(deadline);
      resolve(f);
    };
    const fail = (msg: string) => {
      if (!alive()) return;
      settled = true;
      cleanup();
      clearTimeout(deadline);
      reject(msg);
    };
    const settleWithBest = () => {
      if (best && best.accuracyMeters <= ZONE_AUTO_CENTRE_MAX_ACCURACY_M) finish(best);
      else fail(best ? coarseFixMessage(best.accuracyMeters) : LOCATION_TIMEOUT_HELP);
    };
    const deadline = setTimeout(() => {
      if (!alive()) return;
      settleWithBest();
    }, CHAIN_DEADLINE_MS);
    const toFix = (pos: GeolocationPosition): ForegroundFix => ({
      lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyMeters: pos.coords.accuracy,
      quality: classifyAccuracy(pos.coords.accuracy, CALIBRATION_OPEN), at: fixTimestamp(pos.timestamp),
    });
    /** Record a delivered fix: track the best, report progress, and
     *  count identical repeats for the static-provider short-circuit. */
    const noteDelivered = (f: ForegroundFix): boolean => {
      if (!best || f.accuracyMeters < best.accuracyMeters) {
        best = f;
        lastBestCoarse = f;
        onProgress?.(best.accuracyMeters, stage);
      }
      if (lastDelivered && lastDelivered.lat === f.lat && lastDelivered.lng === f.lng && lastDelivered.accuracyMeters === f.accuracyMeters) {
        identicalStreak += 1;
      } else {
        identicalStreak = 0;
      }
      lastDelivered = f;
      // A repeat from a DIFFERENT stage means the provider is static:
      // later stages would return the same fix, so stop the chain.
      return identicalStreak >= 1;
    };
    const isStaticProvider = () => identicalStreak >= 1;

    /** One-shot stage: getCurrentPosition with its own backstop
     *  timer (the browser may never call back at all — observed in
     *  headless Chromium — so the stage timeout, not the browser,
     *  decides when to move on). Returns 'good' (resolve with the
     *  best fix), 'denied', or 'next'. */
    const oneShot = (opts: PositionOptions, timeoutMs: number, label: string): Promise<'good' | 'denied' | 'next'> =>
      new Promise((res) => {
        stage = label;
        onProgress?.(best?.accuracyMeters ?? null, stage);
        let done = false;
        const to = setTimeout(() => { if (!done) { done = true; res('next'); } }, timeoutMs);
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            if (done || !alive()) return;
            done = true;
            clearTimeout(to);
            const f = toFix(pos);
            noteDelivered(f);
            if (isGoodFix(f)) { res('good'); return; }
            res('next');
          },
          (err) => {
            if (done || !alive()) return;
            done = true;
            clearTimeout(to);
            res(err.code === 1 ? 'denied' : 'next');
          },
          opts,
        );
      });

    /** Watch stage: high-accuracy watchPosition for `timeoutMs`.
     *  Resolves on the first GOOD fix; otherwise 'next' when the
     *  stage times out (the watch is cleared — a hanging watch must
     *  never block the next stage). */
    const watchStage = (timeoutMs: number): Promise<'good' | 'denied' | 'next'> =>
      new Promise((res) => {
        stage = 'Trying high-accuracy GPS…';
        onProgress?.(best?.accuracyMeters ?? null, stage);
        let done = false;
        const to = setTimeout(() => {
          if (done) return;
          done = true;
          cleanup();
          res('next');
        }, timeoutMs);
        watchId = navigator.geolocation.watchPosition(
          (pos) => {
            if (done || !alive()) return;
            const f = toFix(pos);
            latestWatchedFix = f;
            noteDelivered(f);
            if (isGoodFix(f)) {
              done = true;
              clearTimeout(to);
              res('good');
            }
          },
          (err) => {
            if (done || !alive()) return;
            done = true;
            clearTimeout(to);
            res(err.code === 1 ? 'denied' : 'next');
          },
          { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs },
        );
      });

    void (async () => {
      // Stage 0: permission state. Denied skips GPS entirely — no
      // spinner, no waiting — and the UI makes tap-the-map primary.
      // 'prompt'/'granted'/'unknown' all proceed (asking is worth trying).
      stage = 'Checking location permission…';
      const perm = await checkLocationPermission();
      if (!alive()) return;
      if (perm === 'denied') { fail(LOCATION_DENIED_HELP); return; }

      // Stage 1: high-accuracy watch (12 s). A watch keeps delivering
      // as GPS locks and refines, so the first GOOD fix wins; a
      // one-shot would return the first (coarse, indoor) fix.
      const w = await watchStage(12_000);
      if (!alive()) return;
      if (w === 'denied') { fail(LOCATION_DENIED_HELP); return; }
      if (w === 'good' && best) { finish(best); return; }

      // Stage 2: high-accuracy one-shot (10 s). The watch may have
      // been starved by another watcher (an active high-accuracy
      // watcher starves fresh one-shots); a one-shot is the next
      // method to try.
      const s2 = await oneShot({ enableHighAccuracy: true, maximumAge: 0, timeout: 10_000 }, 10_000, 'Trying one-shot GPS…');
      if (!alive()) return;
      if (s2 === 'denied') { fail(LOCATION_DENIED_HELP); return; }
      if (s2 === 'good' && best) { finish(best); return; }
      if (isStaticProvider()) { settleWithBest(); return; }

      // Stage 3: low-accuracy one-shot (15 s). Indoors, high accuracy
      // may never answer while the network provider would.
      const s3 = await oneShot({ enableHighAccuracy: false, maximumAge: 0, timeout: 15_000 }, 15_000, 'Trying standard GPS (low accuracy)…');
      if (!alive()) return;
      if (s3 === 'denied') { fail(LOCATION_DENIED_HELP); return; }
      if (s3 === 'good' && best) { finish(best); return; }
      if (isStaticProvider()) { settleWithBest(); return; }

      // Stage 4: cached one-shot (maximumAge 5 min, 8 s). The ONLY
      // stage that accepts a cached fix — and only within ±50 m.
      // Better a 4-minute-old real fix than nothing, when the host
      // can see its age and accuracy before accepting it.
      const s4 = await oneShot({ enableHighAccuracy: false, maximumAge: CACHED_FIX_MAX_AGE_MS, timeout: 8_000 }, 8_000, 'Trying the last known location…');
      if (!alive()) return;
      if (s4 === 'denied') { fail(LOCATION_DENIED_HELP); return; }
      if (s4 === 'good' && best) { finish(best); return; }

      // End of the chain: best within ±50 m wins; a coarser best is
      // rejected with its accuracy (and kept in getBestCoarseFix for
      // the "use this approximate spot" offer); nothing at all is
      // the timeout help.
      settleWithBest();
    })();
  });
}
