/**
 * v31 map-refresh tests (Meera) — Fix 2: map goes blank on refresh.
 *
 * WHAT THE FIELD REPORT + CODE PROVE (play-map-logic.ts / PlayMap.tsx):
 * - The pill "Re-centre failed — try again" renders ONLY when
 *   `mapState === 'ready'` (pillTextForStateRaw: the recentreFailed
 *   part exists only in the ready branch) — so the style loaded and
 *   `map.on('load')` fired, yet nothing painted: no tiles, no zone
 *   polygon, no dot. No tile-error / other-resource / fit-failed part
 *   was in the pill either, so no resource failure was recorded.
 * - The ◎ button is `disabled={!mapReady}`, so the founder could tap
 *   it — and `recentreFailed` is set ONLY in `centreOn`'s catch, so
 *   `map.easeTo` THREW on a ready map with a finite centre (the
 *   resolver guarantees one). The instance is wedged — a stalled
 *   render loop or a lost GL context — not bad input.
 * - The setup map uses the SAME `createOlaMap` + key + phone and
 *   paints, so Ola / key / network / SW route are not the cause.
 * - The exact GL-level cause is NOT provable from code — only the
 *   founder's phone can confirm it. What code CAN fix is the
 *   dead-end around it:
 *   (1) a 'ready' map with a failed ◎ tap offered NO Retry (the
 *       inline condition did not include `recentreFailed`) — the
 *       only in-app escape from a wedged instance is a rebuild;
 *   (2) the first paint frame was never forced after 'load' (the
 *       first-load path gets its repaint from the role-reveal
 *       dismissal; a refresh has no reveal, so no repaint);
 *   (3) a context lost during construction / style load fired with
 *       NO listener attached (the caller's listeners only attach
 *       after `createOlaMap` resolves), so the honest "Map graphics
 *       lost" pill never showed;
 *   (4) the creation effect's cleanup removed the map but left
 *       `mapReady` / `mapState` presenting as 'ready'.
 *
 * These tests pin the REAL pure helper (`shouldOfferMapRetry`) and
 * the component wiring via source pins — PlayMap needs React/DOM.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const { shouldOfferMapRetry } = await import('../src/components/hud/play-map-logic.ts');

const CLEAN_READY = {
  mapState: 'ready',
  tileErrorCount: 0,
  fitFailed: false,
  fitPending: false,
  zeroHeight: false,
  zeroWidth: false,
  hasOtherResource: false,
  recentreFailed: false,
  contextLost: false,
};

test('clean ready map offers NO Retry (unchanged behaviour)', () => {
  assert.equal(shouldOfferMapRetry(CLEAN_READY), false);
});

test('ready + lost GL context offers Retry (F2 fix round)', () => {
  // The pill says "Map graphics lost — try Retry" for ready +
  // contextLost, but the mapping never saw `contextLost`, so no
  // button rendered — the promise was a dead end.
  assert.equal(shouldOfferMapRetry({ ...CLEAN_READY, contextLost: true }), true);
});

test('ready + failed re-centre offers Retry — the v30 founder state', () => {
  assert.equal(shouldOfferMapRetry({ ...CLEAN_READY, recentreFailed: true }), true);
});

test('every other failure state still offers Retry (no regression)', () => {
  assert.equal(shouldOfferMapRetry({ ...CLEAN_READY, tileErrorCount: 2 }), true);
  assert.equal(shouldOfferMapRetry({ ...CLEAN_READY, tileErrorCount: 1 }), true);
  assert.equal(shouldOfferMapRetry({ ...CLEAN_READY, fitFailed: true }), true);
  assert.equal(shouldOfferMapRetry({ ...CLEAN_READY, fitPending: true }), true);
  assert.equal(shouldOfferMapRetry({ ...CLEAN_READY, zeroHeight: true }), true);
  assert.equal(shouldOfferMapRetry({ ...CLEAN_READY, zeroWidth: true }), true);
  assert.equal(shouldOfferMapRetry({ ...CLEAN_READY, hasOtherResource: true }), true);
});

test('any non-ready state offers Retry', () => {
  for (const mapState of ['loading', 'error', 'no-key', 'unavailable']) {
    assert.equal(
      shouldOfferMapRetry({ ...CLEAN_READY, mapState }),
      true,
      `mapState ${mapState} must offer Retry`,
    );
  }
});

// -- Source pins: the component wiring behind the fix. ---------------
const playMapSrc = readFileSync(
  new URL('../src/components/hud/PlayMap.tsx', import.meta.url),
  'utf8',
);
const maplibreSrc = readFileSync(
  new URL('../src/components/map/maplibre.ts', import.meta.url),
  'utf8',
);

test('source pin: the pill Retry button renders from shouldOfferMapRetry, not an inline condition', () => {
  assert.match(playMapSrc, /const offerRetry = shouldOfferMapRetry\(\{/);
  assert.match(playMapSrc, /\{offerRetry \? \(/);
  assert.doesNotMatch(
    playMapSrc,
    /\{mapState !== 'ready' \|\| tileLedger\.count > 0/,
    'the old inline condition (which omitted recentreFailed) must be gone',
  );
});

test('source pin: the call site passes contextLost into shouldOfferMapRetry (F2 fix round)', () => {
  const callStart = playMapSrc.indexOf('const offerRetry = shouldOfferMapRetry({');
  assert.notEqual(callStart, -1, 'the offerRetry call must exist');
  const callBlock = playMapSrc.slice(callStart, playMapSrc.indexOf('});', callStart));
  assert.match(callBlock, /contextLost,/);
  assert.match(callBlock, /recentreFailed,/);
});

test('source pin: the load handler forces one paint frame after resize', () => {
  const loadBlock = playMapSrc.slice(
    playMapSrc.indexOf("map.on('load'"),
    playMapSrc.indexOf("map.on('error'"),
  );
  assert.match(loadBlock, /map\.triggerRepaint\(\)/);
});

test('source pin: a failed re-centre attempts one repaint before recording the failure', () => {
  // Re-pointed (v33): `applyRecentreSuccess` now holds the first
  // `setRecentreFailed(false)` and sits before the try/catch, so the
  // old slice (centreOn → first success) ended before the catch.
  // The landed shape: the catch repaints, then records the failure.
  const centreStart = playMapSrc.indexOf('const centreOn = useCallback');
  const catchAt = playMapSrc.indexOf('} catch {', centreStart);
  const failAt = playMapSrc.indexOf('setRecentreFailed(true);', catchAt);
  assert.ok(catchAt >= 0 && failAt > catchAt, 'centreOn must catch a failed easeTo and record the failure');
  const catchBlock = playMapSrc.slice(catchAt, failAt);
  assert.match(catchBlock, /map\.triggerRepaint\(\)/, 'the catch repaints before recording the failure');
});

test('source pin: context-loss listeners attach inside createOlaMap, at construction', () => {
  assert.match(maplibreSrc, /onContextLost\?: \(\) => void;/);
  assert.match(maplibreSrc, /onContextRestored\?: \(\) => void;/);
  assert.match(maplibreSrc, /canvas\.addEventListener\('webglcontextlost'/);
  assert.match(maplibreSrc, /canvas\.addEventListener\('webglcontextrestored'/);
  assert.match(
    playMapSrc,
    /onContextLost: \(\) => setContextLost\(true\)/,
    'PlayMap passes the loss callback into createOlaMap',
  );
  assert.doesNotMatch(
    playMapSrc,
    /const onContextLost = \(event: Event\)/,
    'the late caller-side attach must be gone (one attach point, earliest)',
  );
});

test('source pin: the creation-effect cleanup resets the ready state with the removed map', () => {
  const cleanupBlock = playMapSrc.slice(
    playMapSrc.indexOf('mapRef.current?.remove();'),
    playMapSrc.indexOf('Re-created only when the user taps Retry'),
  );
  assert.match(cleanupBlock, /loadedRef\.current = false;/);
  assert.match(cleanupBlock, /setMapReady\(false\);/);
  assert.match(cleanupBlock, /setMapState\('loading'\);/);
});
