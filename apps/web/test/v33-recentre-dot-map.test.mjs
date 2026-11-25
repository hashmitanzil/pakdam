/**
 * v33 FIX 3 (re-scoped) + FIX 4 (re-scoped) + FIX 5 — re-centre
 * fallback, removed-state map repaint, dot display (Arjun, QA).
 *
 * CORRECTIONS (Diya's adversarial review, 2026-11-25 — the first
 * draft of this file pinned two DISPROVEN theories and has been
 * rewritten):
 *
 * - FIX 3: Diya verified the no-fix fallback IS unconditional —
 *   `centreOn` resolves the centre through `resolveRecentreCentre`
 *   (fix → zone centroid → Ranchi default, never non-finite) and
 *   sets the loud `recentreFallback` pill ('zone'/'default') on the
 *   success path. There is no "fallback never fires" to pin. The
 *   REAL v33 bit is the FAILURE path: an `easeTo` throw on a ready
 *   map does one best-effort repaint (v31) and then records
 *   `recentreFailed` — NO second camera attempt. v33 LANDED the
 *   RETRY after the repaint: the same ease once, on the next
 *   animation frame (a synchronous second ease would throw against
 *   the same wedged loop), identity-guarded, clearing the failure
 *   through the shared `applyRecentreSuccess` when it lands.
 *
 * - FIX 4: Diya verified NEITHER removed-state render path can
 *   blank the map — the seatRemoved early-return and the
 *   `removedAt` banner both leave `<PlayMap>` mounted in the paths
 *   that can actually render. There is no "removed-state blanks
 *   the map" to pin. The REAL v33 bit is the RETURN path: on
 *   visibilitychange/focus return a canvas that MATCHES its
 *   container in size but is BLACK (no tiles painted — the
 *   founder's field symptom: map black with a "Map ready" pill)
 *   gets NO repaint, because `verifyCanvasPainted` only repaints
 *   on a size MISMATCH. v33: repaint unconditionally on return.
 *
 * HEADLESS LIMIT, stated plainly (narrowed by Meera's v33 landing):
 * headless cannot prove tiles actually painted. `canvasMatchesContainer`
 * is a SIZE check only (1 px tolerance) — a black canvas of the right
 * size passes it. Meera landed a 'render' stall guard (every frame
 * stamps the clock; a requested repaint with no later frame is a
 * stalled loop, named by the `paintStalled` pill) plus a 'style.load'
 * context-restore re-sync — so loop-dead vs loop-alive IS now pinned
 * below. But a frame still renders with no tiles on it: tiles-painted
 * vs black still needs a live browser (pixel sampling). Real paint
 * proof is flagged as unpinnable here, not faked.
 *
 * FIX 5 (dot): when a validated fix exists the YOU marker renders
 * and the camera keeps it on screen; the marker survives hide/show.
 * Today the marker effect re-runs only on [mapReady, myFix, nowMs]
 * — a tab return with an unchanged (stale) fix never re-positions
 * it — and there is no fix-in-view check at all (only
 * `zoneBboxInView` for the ZONE). Both are pinned failing-first.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const {
  resolveRecentreCentre,
  pillTextForState,
  isFixStale,
  meDotMarkerStyle,
  meAccuracyFeatures,
  appendTrailPoint,
  canvasMatchesContainer,
  handleMapTabReturn,
  shouldOfferMapRetry,
  zoneBboxInView,
  RECENTRE_FAILED_COPY,
  RECENTRE_NO_FIX_ZONE_PILL,
  RECENTRE_NO_FIX_DEFAULT_PILL,
} = await import('../src/components/hud/play-map-logic.ts');
const { FakeMapLibreMap } = await import('./fake-map.mjs');

const playMapSrc = readFileSync(
  new URL('../src/components/hud/PlayMap.tsx', import.meta.url),
  'utf8',
);

const TRIANGLE = [
  { lng: 85.32, lat: 23.34 },
  { lng: 85.34, lat: 23.34 },
  { lng: 85.33, lat: 23.36 },
];

function fix({ lng = 85.33, lat = 23.35, accuracyMeters = 8, timestampMs = Date.now() } = {}) {
  return { lng, lat, accuracyMeters, timestampMs };
}

/** The `centreOn` callback body (from `const centreOn = useCallback(` to the dep array close). */
function centreOnBody() {
  const start = playMapSrc.indexOf('const centreOn = useCallback(');
  assert.ok(start >= 0, 'centreOn must exist in PlayMap');
  const end = playMapSrc.indexOf('[myFix, zoneBoundary, mapReady, nowMs]', start);
  assert.ok(end > start, 'centreOn dep array must exist');
  return playMapSrc.slice(start, end);
}

/** The marker effect body (the effect that creates/positions the YOU marker). */
function markerEffectBody() {
  // The marker effect is the useEffect whose body mentions meMarkerRef
  // and setLngLat — slice from its useEffect( through the dep array
  // close, so the deps are inside the slice. Anchor on
  // `positionMarker`: it is defined only inside the marker effect
  // (the first `meMarkerRef` in the file is its `useRef` declaration,
  // which belongs to no effect). The end anchors on the dep array
  // itself (`}, [mapReady`): a bare `]);` would stop at
  // `setLngLat([fix.lng, fix.lat])` mid-effect.
  const anchor = playMapSrc.indexOf('const positionMarker');
  assert.ok(anchor >= 0, 'positionMarker must exist in PlayMap');
  const start = playMapSrc.lastIndexOf('useEffect(', anchor);
  const depsAt = playMapSrc.indexOf('}, [mapReady', start);
  assert.ok(start >= 0 && depsAt > start, 'marker effect must exist');
  const end = playMapSrc.indexOf(']);', depsAt);
  return playMapSrc.slice(start, end + 3);
}

// -- FIX 3: re-centre fallback (re-scoped). --------------------------------
test('v33 FIX 3 (regression): no fix → zone centroid, never a non-finite centre', () => {
  const { centre, source } = resolveRecentreCentre(null, TRIANGLE);
  assert.equal(source, 'zone');
  assert.ok(Number.isFinite(centre.lng) && Number.isFinite(centre.lat));
  assert.ok(centre.lng > 85.32 && centre.lng < 85.34);
  assert.ok(centre.lat > 23.34 && centre.lat < 23.36);
  const dflt = resolveRecentreCentre(null, null);
  assert.equal(dflt.source, 'default');
  assert.ok(Number.isFinite(dflt.centre.lng) && Number.isFinite(dflt.centre.lat));
  const withFix = resolveRecentreCentre(fix(), TRIANGLE);
  assert.equal(withFix.source, 'fix');
  assert.equal(withFix.centre.lng, 85.33);
});

test('v33 FIX 3 (regression): the loud zone-centre pill shows on the no-fix path', () => {
  // The pill is rendered from `recentreFallback` state (PlayMap):
  // 'zone' → RECENTRE_NO_FIX_ZONE_PILL, 'default' → ..._DEFAULT_PILL.
  assert.equal(RECENTRE_NO_FIX_ZONE_PILL, 'No GPS fix — showing zone centre');
  assert.equal(RECENTRE_NO_FIX_DEFAULT_PILL, 'No GPS fix — showing Ranchi');
  assert.match(
    playMapSrc,
    /\{recentreFallback === 'zone' \? RECENTRE_NO_FIX_ZONE_PILL : RECENTRE_NO_FIX_DEFAULT_PILL\}/,
    'the loud pill must render from recentreFallback',
  );
  // And centreOn sets that state on the no-fix success path (not a footnote).
  // v33: the fallback logic lives in the shared `applyRecentreSuccess`
  // helper (direct ease + the one retry both land through it).
  const body = centreOnBody();
  assert.ok(
    /else if \(landedSource === 'zone'\) \{[\s\S]{0,200}?setRecentreFallback\('zone'\);/.test(body) ||
      /else if \(source === 'zone'\) \{[\s\S]{0,200}?setRecentreFallback\('zone'\);/.test(body),
    'centreOn must set the zone fallback on the no-fix success path',
  );
  assert.match(body, /setRecentreFallback\('default'\);/);
});

test('v33 FIX 3 (regression): an easeTo failure on a ready map triggers a repaint before recording the failure', () => {
  const body = centreOnBody();
  const catchAt = body.indexOf('} catch {');
  assert.ok(catchAt >= 0, 'centreOn must have a catch for a failed easeTo');
  const catchBody = body.slice(catchAt);
  assert.match(catchBody, /map\.triggerRepaint\(\)/, 'the catch must repaint first (v31)');
  assert.match(catchBody, /setRecentreFailed\(true\);/, 'the failure is still recorded');
  assert.equal(RECENTRE_FAILED_COPY, 'Re-centre failed — try again');
  // The failed copy is the only copy a tap failure may set (allow-list).
  assert.match(
    pillTextForState('ready', null, false, null, 0, null, false, false, null, null, false, false, null, true, false),
    /Re-centre failed — try again/,
  );
});

test('v33 FIX 3: an easeTo failure on a ready map RETRIES the camera move after the repaint', () => {
  // LANDED (v33 FIX 3, Diya: retry-after-repaint): the catch does
  // one best-effort repaint, then retries the SAME ease once on the
  // next animation frame — a synchronous second ease would throw
  // against the same wedged loop, because the repaint is async (it
  // schedules a frame). The retry is identity-guarded (same map
  // instance) and, on landing, clears the failure via the shared
  // `applyRecentreSuccess`. No `requestAnimationFrame` (SSR / node
  // tests) degrades to the v31 behaviour: repaint, then record.
  // The pin accepts the retry in either shape: a second camera call
  // (`easeToCentre`, the shared ease helper) or the rAF scheduling
  // itself, after the repaint in the catch.
  const body = centreOnBody();
  const catchAt = body.indexOf('} catch {');
  assert.ok(catchAt >= 0, 'centreOn must have a catch for a failed easeTo');
  const catchBody = body.slice(catchAt);
  const repaintAt = catchBody.indexOf('map.triggerRepaint()');
  assert.ok(repaintAt >= 0, 'precondition: the catch repaints (v31)');
  const afterRepaint = catchBody.slice(repaintAt);
  assert.ok(
    /easeToCentre\(|map\.easeTo\(|map\.fitBounds\(|map\.flyTo\(|tryFitZone\(|centreOn\(|requestAnimationFrame\(|setTimeout\(/.test(afterRepaint),
    'after the repaint the catch must retry the camera move (second ease via easeToCentre, a re-invocation of centreOn, or a scheduled retry) instead of only recording recentreFailed',
  );
  assert.match(afterRepaint, /applyRecentreSuccess\(retrySource\)/, 'a landed retry must clear the failure through the shared success path');
});

// -- FIX 4: repaint on return; paint vs blank (re-scoped). ----------------
test('v33 FIX 4 (regression): handleMapTabReturn resizes, re-fits and repaints a sized map', () => {
  const map = new FakeMapLibreMap();
  const fittedRef = { current: false };
  const out = handleMapTabReturn(map, TRIANGLE, fittedRef, true);
  assert.equal(out.status, 'resized');
  assert.ok(map.calls.some((c) => c.method === 'resize'), 'tab return resizes');
  assert.ok(map.calls.some((c) => c.method === 'triggerRepaint'), 'tab return repaints');
  const hidden = handleMapTabReturn(map, TRIANGLE, fittedRef, false);
  assert.equal(hidden.status, 'hidden');
});

test('v33 FIX 4: the visibilitychange return path repaints UNCONDITIONALLY — a size-matching but black canvas is repainted too', () => {
  // The remeasure effect (visibilitychange + window resize) runs
  // `map.resize()` + `verifyCanvasPainted(false)` — and
  // verifyCanvasPainted only repaints on a size MISMATCH. A canvas
  // that matches its container in size but painted nothing (the
  // founder's black map with a "Map ready" pill) gets NO repaint
  // on return. v33: the return path calls `map.triggerRepaint()`
  // directly, outside the mismatch-only ladder.
  const visAt = playMapSrc.indexOf("document.addEventListener('visibilitychange', onVisibility)");
  assert.ok(visAt >= 0, 'PlayMap must listen for visibilitychange');
  const effectStart = playMapSrc.lastIndexOf('useEffect(() => {', visAt);
  const effectEnd = playMapSrc.indexOf('}, [mapReady, checkMapAreaHeight, verifyCanvasPainted]);', effectStart);
  assert.ok(effectStart >= 0 && effectEnd > effectStart, 'the remeasure effect must exist');
  const effect = playMapSrc.slice(effectStart, effectEnd);
  assert.ok(effect.includes('verifyCanvasPainted'), 'precondition: the effect verifies the canvas');
  assert.ok(
    /map\.triggerRepaint\(\)/.test(effect),
    'the visibilitychange/resize return path must triggerRepaint() directly — verifyCanvasPainted alone only repaints on a size mismatch, so a black-but-right-sized canvas is never repainted',
  );
});

test('v33 FIX 4: a window focus return also remeasures/repaints the map', () => {
  // CONDITIONAL: visibilitychange covers the app-switch return on
  // mobile; a 'focus' listener is the desktop belt-and-braces for
  // a window refocus that does not fire visibilitychange. If Meera
  // implements the return repaint through visibilitychange only,
  // this test fails post-fix and the coordinator reconciles it.
  assert.match(
    playMapSrc,
    /window\.addEventListener\('focus',/,
    'PlayMap must listen for window focus returns, not only visibilitychange',
  );
});

test('v33 FIX 4 (paint signal — LANDED): the map stamps every rendered frame, so a stalled loop is visible (no size-only check can see it)', () => {
  // CORRECTION to the first draft's limitation test: Meera landed
  // the v33 FIX 4 stall guard — `map.on('render', ...)` stamps
  // `lastRenderAtMsRef` on every frame (MapLibre fires 'render' at
  // the end of every frame) and clears a `paintStalled` flag the
  // moment frames resume. A requested repaint with no later frame
  // is a stalled loop. The pill can name it: `pillTextForState`
  // takes a `paintStalled` flag.
  assert.match(
    playMapSrc,
    /map\.on\('render', \(\) => \{[\s\S]{0,300}?lastRenderAtMsRef\.current = Date\.now\(\);/,
    'PlayMap must stamp the clock on every rendered frame',
  );
  assert.match(playMapSrc, /paintStalled/, 'the stall flag must exist');
  assert.match(
    playMapSrc,
    /map\.on\('style\.load',/,
    'a context restore re-syncs sources and repaints on style.load',
  );
});

test('v33 FIX 4 (LIMITATION — passes, documents the remaining headless gap): the size check is size-only, and a rendered frame is not proof tiles painted', () => {
  // canvasMatchesContainer returns true for two equal rects — it
  // proves the canvas is the right SIZE, not that any tile ever
  // painted. The new 'render' stall guard narrows the gap (it
  // proves the loop is ALIVE), but a frame still renders with no
  // tiles on it — a black canvas renders frames. So: loop-dead vs
  // loop-alive is now pinned above; tiles-painted vs black still
  // needs a live browser (pixel sampling) and is NOT proven by
  // this test. Do NOT read this pass as "the map paints".
  assert.equal(
    canvasMatchesContainer({ width: 660, height: 525 }, { width: 660, height: 525 }),
    true,
    'equal rects match — including a black canvas of the right size',
  );
  assert.equal(
    canvasMatchesContainer({ width: 660, height: 525 }, { width: 660, height: 524 }),
    true,
    '1 px tolerance still matches',
  );
  assert.equal(
    canvasMatchesContainer({ width: 660, height: 525 }, { width: 660, height: 400 }),
    false,
    'a genuinely wrong size still mismatches',
  );
});

test('v33 FIX 4 (regression): a clean ready map offers no Retry — the pill is honest', () => {
  assert.equal(
    shouldOfferMapRetry({
      mapState: 'ready',
      tileErrorCount: 0,
      fitFailed: false,
      fitPending: false,
      zeroHeight: false,
      zeroWidth: false,
      hasOtherResource: false,
      recentreFailed: false,
      contextLost: false,
    }),
    false,
  );
  const map = new FakeMapLibreMap();
  const containerRect = map.containerRect();
  const canvasRect = map.canvasRect();
  assert.ok(containerRect.width > 0 && containerRect.height > 0, 'FakeMap container is non-zero');
  assert.ok(canvasRect.width > 0 && canvasRect.height > 0, 'FakeMap canvas is non-zero');
});

// -- FIX 5: dot display. ---------------------------------------------------
test('v33 FIX 5 (regression): the YOU marker is an 18×18 square, round, border inside the box', () => {
  const style = meDotMarkerStyle(false);
  assert.equal(style.width, '18px');
  assert.equal(style.height, '18px');
  assert.equal(style.borderRadius, '999px');
  assert.match(style.boxSizing ?? '', /border-box/);
  const stale = meDotMarkerStyle(true);
  assert.notEqual(stale.opacity, style.opacity, 'a stale fix fades the dot');
});

test('v33 FIX 5 (regression): a validated fix draws an accuracy ring; a rough fix draws a bigger one, never nothing', () => {
  const features = meAccuracyFeatures(fix({ accuracyMeters: 8 }));
  assert.equal(features.length, 1, 'a validated fix draws its accuracy ring');
  const rough = meAccuracyFeatures(fix({ accuracyMeters: 60 }));
  assert.equal(rough.length, 1, 'a rough-but-valid fix still draws (bigger ring)');
  assert.equal(meAccuracyFeatures(null).length, 0, 'no fix → no ring');
});

test('v33 FIX 5 (regression): the trail gate is distance-only (~11 m) — a long gap alone never appends', () => {
  const trail = [];
  const now = Date.now();
  const first = appendTrailPoint(trail, fix({ timestampMs: now }), now);
  assert.equal(first.length, 1);
  // 2 m away after a LONG gap: still no new point (distance-only, v30).
  const near = appendTrailPoint(first, fix({ lng: 85.33002, timestampMs: now + 300_000 }), now + 300_000);
  assert.equal(near.length, 1, 'a just-under-11 m move after a long gap still does not append');
  // A real move (≥ ~11 m) appends exactly one point.
  const far = appendTrailPoint(first, fix({ lng: 85.3302, timestampMs: now + 5_000 }), now + 5_000);
  assert.equal(far.length, 2);
});

test('v33 FIX 5 (regression): a fix older than 60 s is stale, a fresh fix is not', () => {
  const now = Date.now();
  assert.equal(isFixStale(fix({ timestampMs: now }), now), false);
  assert.equal(isFixStale(fix({ timestampMs: now - 61_000 }), now), true);
  assert.equal(isFixStale(null, now), false);
});

test('v33 FIX 5 (regression): the zone-in-view helper exists and is used — the pattern the fix check must follow', () => {
  // Zoom 13: 660 px ≈ 0.057° lng, 525 px ≈ 0.041° lat — the 0.02° ×
  // 0.02° triangle fits comfortably (at zoom 14 the 0.020° lat span
  // is exactly the visible height, so it does NOT fit).
  const map = new FakeMapLibreMap({ centre: [85.33, 23.35], zoom: 13 });
  assert.equal(zoneBboxInView(map, TRIANGLE, 660, 525), true);
  map.easeTo({ center: [85.0, 23.0] });
  assert.equal(zoneBboxInView(map, TRIANGLE, 660, 525), false);
  assert.match(playMapSrc, /zoneBboxInView\(map, zoneBoundaryRef\.current, width, height\)/);
});

test('v33 FIX 5: the YOU marker effect re-positions on tab return — its deps include resizeNonce', () => {
  // The marker is positioned from `myFixRef` in an effect whose deps
  // are [mapReady, myFix, nowMs]. A tab return with an UNCHANGED
  // (stale) fix never re-runs it, so the marker is never
  // re-positioned after the map was resized/repainted on return.
  // `resizeNonce` already bumps on tab change / role-reveal dismiss
  // (the resize effect consumes it); the marker effect must too.
  const body = markerEffectBody();
  const depsAt = body.lastIndexOf('}, [');
  assert.ok(depsAt >= 0, 'the marker effect must have a dep array');
  const deps = body.slice(depsAt);
  assert.match(
    deps,
    /resizeNonce/,
    `the marker effect deps must include resizeNonce so a tab return re-positions the dot (got ${deps.trim()})`,
  );
});

test('v33 FIX 5: the camera keeps the fix on screen — a fix-in-view check exists for the ME dot', () => {
  // Only the ZONE has an in-view helper today (`zoneBboxInView`).
  // The fix needs the same: a `*InView*` export that takes the fix
  // (or the map's `getBounds().contains` used on the fix) so the
  // camera can be pulled back when the dot drifts off screen —
  // nothing keeps the dot on screen today except a manual ◎ tap.
  const logicSrc = readFileSync(
    new URL('../src/components/hud/play-map-logic.ts', import.meta.url),
    'utf8',
  );
  const hasFixInView =
    /export function \w*[Ff]ix\w*InView\w*\(/.test(logicSrc) ||
    /export function \w*InView\w*[Ff]ix\w*\(/.test(logicSrc) ||
    /export function me\w*InView\w*\(/.test(logicSrc);
  const playMapUsesContains = /getBounds\(\)\.contains\(/.test(playMapSrc);
  assert.ok(
    hasFixInView || playMapUsesContains,
    'a fix-in-view check must exist (a *InView* helper for the fix in play-map-logic, or getBounds().contains in PlayMap) so the camera keeps the YOU dot on screen',
  );
});
