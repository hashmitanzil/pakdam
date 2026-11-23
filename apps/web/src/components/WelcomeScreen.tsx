'use client';

/**
 * WelcomeScreen — the launch / loading screen, shown on every home
 * mount / reload (page.tsx renders it until it calls `onDone`).
 *
 * Dark #0A0A0B. Hero art is the founder lockup
 * (pakdam-logo-lockup.webp), split into three staged crops so the pin,
 * the wordmark and the tagline animate separately, in sequence — pin
 * drops in with a ping-ring pulse first, then the PAKDAM wordmark
 * rises, then the tagline fades (all done by ~1 s; see the render
 * comment for exact timings). Under the tagline, a single
 * "Loading game" line — static text with a subtle pulse at most, no
 * loading bar, no step list, no percentage, no fake progress. The
 * real work still runs behind the screen, never fake:
 *
 *   (a) GPS warm-up — ONE getCurrentPosition, 1 s timeout, no watch,
 *       and ONLY when location permission is already 'granted'
 *       (navigator.permissions.query). When the state is 'prompt' or
 *       'denied', or the Permissions API is unavailable, the work is
 *       skipped silently — the home page never pops the system
 *       location prompt. Failure (denied / unavailable / timeout)
 *       is fine.
 *   (b) connection check — a GET to the Worker root via the existing
 *       getWorkerUrl() helper. Any HTTP response counts as reachable;
 *       a network error counts as not reachable. In demo mode (no
 *       Worker URL configured) there is nothing to reach, so the work
 *       resolves immediately. No room, no ticket, no game state touched.
 *
 * v29 (R11): the map asset prefetch used to be job (a) here — it is
 * REMOVED from this screen. The welcome screen shows before the
 * player has chosen to play, so prefetching ~1 MB of map assets here
 * spends data on a screen that may never open a map. Play-map
 * readiness is protected another way: the lobby prefetches on mount
 * (everyone in the lobby will open the map), and host setup /
 * create-mode still prefetch.
 *
 * The two jobs run concurrently. A job that fails just settles —
 * never an error state, never a retry prompt.
 *
 * NEVER BLOCKS: a hard cap of 2.5 s from mount forces the fade even if
 * jobs are still pending or failed. The overlay then crossfades
 * (~400 ms, ~150 ms under prefers-reduced-motion) and unmounts via
 * `onDone`. Under reduced motion there is no drop/pulse animation —
 * static logo, quick fade only. The fade never starts before the
 * staged reveal has finished (~1 s, WELCOME_STAGING_MS): the fast
 * path used to fire at ~0.5 s, while the tagline was still opacity 0.
 *
 * SPEED (founder reference: ShadowHunt's loader lasts ~1 s): the
 * normal path targets ~1 s. Each job has a short budget — GPS gets
 * 1 s, the connection check gets 1 s — and the staging gate holds
 * the fade until ~1 s, so the fade normally starts at ~1 s and the
 * screen is gone by ~1.4 s. A slow job never holds the screen: its
 * budget expiry settles it and the 2.5 s cap is only the ceiling.
 *
 * Shows on EVERY home-page mount / reload, like ShadowHunt — there is
 * deliberately no once-per-session guard (no sessionStorage, no
 * in-memory once-only flag). Navigating back to home shows it again.
 */
import { useEffect, useRef, useState } from 'react';
import { getWorkerUrl } from '../lib/websocket';

export const WELCOME_CAP_MS = 2500;
const WELCOME_FADE_MS = 400;
const WELCOME_FADE_MS_REDUCED_MOTION = 150;
/** Staging gate: the pin → wordmark → tagline sequence finishes at
 * ~950 ms (tagline delay 0.55 s + 0.4 s rise). The fade must not
 * start before then, or the fast path (~500 ms, all jobs settled)
 * would cut the tagline off while it is still opacity 0. The fade
 * fires at max(all-jobs-settled, this gate), capped by WELCOME_CAP_MS. */
const WELCOME_STAGING_MS = 1000;
/** GPS warm-up budget: one fix attempt, then give up quietly. */
const GPS_TIMEOUT_MS = 1000;
/** Connection-check budget for the Worker root GET. */
const CONNECTION_TIMEOUT_MS = 1000;

export function WelcomeScreen({ onDone }: { onDone: () => void }) {
  const [fading, setFading] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const finishedRef = useRef(false);

  useEffect(() => {
    // No once-only guard (founder reference): the screen shows on
    // every home mount / reload, including navigating back to home.
    // The sessionStorage guard that was here was removed 2026-11-21;
    // do not re-add any once-per-session mechanism.
    setReducedMotion(
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );

    // Every timer this effect creates is tracked so the cleanup can
    // clear it; `cancelled` guards every state update so nothing
    // fires after unmount (finish, the fade timer).
    let cancelled = false;
    const effectTimers: number[] = [];
    const later = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        effectTimers.push(window.setTimeout(resolve, ms));
      });
    const connectionController = new AbortController();

    // Fade-out then unmount: guarded so it runs exactly once,
    // whether it fires from the cap timer, from all-jobs-settled,
    // or from the staging gate. The fade timer itself is stored so
    // the cleanup can clear it if the screen unmounts mid-fade.
    const fadeMs = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? WELCOME_FADE_MS_REDUCED_MOTION
      : WELCOME_FADE_MS;
    let fadeTimer: number | undefined;
    const finish = () => {
      if (cancelled || finishedRef.current) return;
      finishedRef.current = true;
      setFading(true);
      fadeTimer = window.setTimeout(() => onDoneRef.current(), fadeMs);
    };

    // (a) GPS warm-up — a single fix, never a watch, never blocking,
    // and ONLY when permission is already 'granted'. A bare
    // getCurrentPosition on mount would pop the system location
    // prompt over the loader on every home visit while undecided,
    // before the user has any reason location is needed. When the
    // state is 'prompt' or 'denied', or the Permissions API is
    // unavailable, the work is skipped silently.
    const gpsWork = (async () => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) {
        return;
      }
      let granted = false;
      try {
        if (typeof navigator.permissions?.query === 'function') {
          const status = await navigator.permissions.query({
            name: 'geolocation',
          });
          granted = status.state === 'granted';
        }
      } catch {
        granted = false;
      }
      if (!granted) {
        return;
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        try {
          navigator.geolocation.getCurrentPosition(done, done, {
            timeout: GPS_TIMEOUT_MS,
            maximumAge: 60000,
            enableHighAccuracy: false,
          });
        } catch {
          done();
          return;
        }
        // Belt and braces: the timeout option should fire the error
        // callback, but resolve anyway if the browser never calls back.
        // Tracked so the cleanup clears it on unmount.
        effectTimers.push(window.setTimeout(done, GPS_TIMEOUT_MS));
      });
    })();

    // (c) Connection check — GET the Worker root via the existing
    // helper. Any HTTP response = reachable; anything else = done
    // anyway (the check never errors, it just settles). The fetch is
    // aborted by the effect cleanup on unmount (in addition to the
    // 1 s budget below, which aborts via the same controller).
    const connectionWork = (async () => {
      const workerUrl = getWorkerUrl();
      if (!workerUrl) {
        return;
      }
      const budgetTimer = window.setTimeout(
        () => connectionController.abort(),
        CONNECTION_TIMEOUT_MS,
      );
      effectTimers.push(budgetTimer);
      try {
        await fetch(`${workerUrl}/`, {
          method: 'GET',
          signal: connectionController.signal,
        });
      } catch {
        // Unreachable / timed out / aborted on unmount — the game
        // still loads; the check simply settles, no error state,
        // no retry prompt.
      } finally {
        window.clearTimeout(budgetTimer);
      }
    })();

    // The two jobs run concurrently. The fade fires only once both have
    // settled AND the staging gate (~1 s) has elapsed — whichever is
    // later — so the full pin → wordmark → tagline sequence is always
    // visible. The hard cap below forces the fade even if any job
    // is still pending or failed.
    const stagingWork = later(WELCOME_STAGING_MS);
    void Promise.allSettled([gpsWork, connectionWork, stagingWork]).then(
      finish,
    );
    const capTimer = window.setTimeout(finish, WELCOME_CAP_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(capTimer);
      if (fadeTimer !== undefined) window.clearTimeout(fadeTimer);
      for (const id of effectTimers) window.clearTimeout(id);
      connectionController.abort();
    };
    // Mount-only: the work must start exactly once, on app launch.
  }, []);

  return (
    <div
      data-testid="welcome-screen"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-[#0A0A0B] px-6"
      style={{
        opacity: fading ? 0 : 1,
        transition: `opacity ${reducedMotion ? WELCOME_FADE_MS_REDUCED_MOTION : WELCOME_FADE_MS}ms ease`,
      }}
    >
      {/* Staged lockup, all art cropped from the one founder lockup
          image (pakdam-logo-lockup.webp, 1424x1616). One flat image
          cannot stage, so the lockup is split into three public/ assets
          (crop boxes measured from the source with PIL, 2026-11-21):
            brand-pin.webp      (1424x885)  — lockup y80-965: crosshair + pin + base ring
            brand-wordmark.webp (1424x255)  — lockup y956-1211: PAKDAM letters only, swoosh removed
            brand-tagline.webp  (1040x59)   — lockup x194-1234, y1311-1370: HIDE • SEEK • CATCH
          Wordmark crop: letters top y968 → 12 px top margin; letters'
          baseline is y1211 (strict red) and the swoosh underline starts
          immediately below it — strict red from y1212, its AA feather
          reaching y1211 (R76-93 at x720-768) — so the crop ends at
          y1211 (exclusive), flush at the baseline with no bottom
          margin; any bottom margin would include swoosh. The 1 px
          shaved off the letters' bottom row (P-stem flat bottom, M-foot
          edge) is invisible at display size. Zero tagline pixels: the
          tagline starts y1323, 112 px below the cut. Tagline crop: text
          x282-1146 (centre 714) y1323-1358 → 88 px side margins,
          12 px top/bottom margins; the swoosh tail (x<84 at these
          rows) is outside the x-range, so the old diagonal streak is
          gone. The pin tip ends at y964 (strict red; rows y965-967 are
          clear), 4 px above the letters; its faint red glow is visible
          in the wordmark's top rows at full resolution but reads as
          ambient glow at display size.
          Animation order / timing (all done by ~1 s):
            0.00 s  pin drops in (0.45 s) + ping rings pulse over it
            0.30 s  wordmark rises/fades in (0.4 s → done 0.70 s)
            0.55 s  tagline fades in (0.4 s → done 0.95 s)
          The "Loading game" line below is visible from mount (the
          real work runs behind it). The fade-out waits for the
          staging gate (~1 s, WELCOME_STAGING_MS) as well as the
          work, so the full sequence is always visible; the 2.5 s
          cap is the ceiling.
          Under reduced motion all three images render statically, no
          drop/rise/pulse, quick fade only. */}
      <div
        className="relative"
        style={{ width: '280px', maxWidth: '72vw' }}
      >
        {/* Ping rings pulsing over the pin art, aligned to the art's
            own thin crosshair circle — measured from the lockup source
            (column crossings + fitted circle, 2026-11-21): centre
            (709, 644), r 508, i.e. 1016 px = 71.4% of the 1424 px
            lockup width, centre at y 564/885 = 63.7% down the pin
            crop. (The ~84% figure in the earlier review was wrong;
            the fitted circle was verified against the red ring at
            seven columns and by a drawn overlay.) The old rings
            (74% wide, centred 48% down) sat too high and produced a
            double-circle look. The ring is a full circle, so its
            bottom arc extends past the pin container into the
            wordmark zone — as the art circle does (it runs behind
            the PAKDAM letters). Skipped under reduced motion. */}
        {!reducedMotion && (
          <>
            <span
              aria-hidden
              className="pakdam-anim-ring absolute left-1/2 top-[64%] aspect-square w-[71%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#EF4444]/50"
            />
            <span
              aria-hidden
              className="pakdam-anim-ring absolute left-1/2 top-[64%] aspect-square w-[71%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#EF4444]/40"
              style={{ animationDelay: '0.9s' }}
            />
          </>
        )}
        <img
          src="/brand-pin.webp"
          alt="Pakdam pin art — a red location pin with a boy hiding behind a tree"
          width={280}
          height={174}
          className={reducedMotion ? undefined : 'pakdam-welcome-drop'}
          style={{ width: '100%', height: 'auto', display: 'block' }}
        />
      </div>

      {/* Wordmark (stage 2) and tagline (stage 3), as images so the
          exact lockup lettering is used — never HTML text over the pin. */}
      <img
        src="/brand-wordmark.webp"
        alt="Pakdam wordmark"
        width={280}
        height={50}
        className={reducedMotion ? undefined : 'pakdam-welcome-rise'}
        style={{
          width: '280px',
          height: 'auto',
          maxWidth: '72vw',
          marginTop: '10px',
          animationDelay: reducedMotion ? undefined : '0.3s',
        }}
      />
      <img
        src="/brand-tagline.webp"
        alt="Hide. Seek. Catch."
        width={200}
        height={11}
        className={reducedMotion ? undefined : 'pakdam-welcome-rise'}
        style={{
          width: '200px',
          height: 'auto',
          maxWidth: '56vw',
          marginTop: '8px',
          animationDelay: reducedMotion ? undefined : '0.55s',
        }}
      />

      {/* Single "Loading game" line under the lockup — no loading
          bar, no step list, no percentage, no fake progress. Subtle
          pulse only, disabled under prefers-reduced-motion via
          motion-safe (Tailwind v4). */}
      <p
        data-testid="welcome-loading-text"
        className="mt-6 text-[15px] font-medium tracking-wide text-[#A1A1AA] motion-safe:animate-pulse"
      >
        Loading game
      </p>
    </div>
  );
}
