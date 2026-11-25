/**
 * v34 (B1 — map BLACK with pill "Map ready"): the tiles-loaded signal.
 *
 * The v33 render-frame stall guard could not catch the founder's
 * field state — loop alive, style loaded, no tile ever painted —
 * because a live loop still renders frames. The pill must derive
 * readiness from the TILE signal, not the loop:
 *
 * - `pillTextForState` with a ready map whose tiles have NOT loaded
 *   says "Loading map tiles…" — never "Map ready";
 * - once the 10 s watchdog fires (`tilesStalled`) it says
 *   "Map tiles not loading — try Retry";
 * - only a ready map WITH tiles loaded reads "Map ready";
 * - `shouldOfferMapRetry` offers Retry for stalled tiles (the black
 *   map had NO working Retry) but NOT for merely-pending tiles
 *   (they resolve on their own or trip the watchdog);
 * - `tilesStalledAfterMs` is the pure watchdog boundary;
 * - PlayMap wires the real signal: an 'idle' listener plus the
 *   `areTilesLoaded()` backstop (installed maplibre-gl 5.x).
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const {
  pillTextForState,
  shouldOfferMapRetry,
  tilesStalledAfterMs,
  TILE_STALL_MS,
} = await import('../src/components/hud/play-map-logic.ts');

const playMapSrc = readFileSync(
  new URL('../src/components/hud/PlayMap.tsx', import.meta.url),
  'utf8',
);

/** A ready map's pill args, with the tiles flags as the last two
 *  (tilesPending = !tilesLoaded — the flag defaults to healthy). */
function readyPill(tilesLoaded, tilesStalled) {
  return pillTextForState(
    'ready',
    'ready',
    false,
    null,
    0,
    null,
    false,
    false,
    null,
    null,
    false,
    false,
    null,
    false,
    false,
    false,
    false,
    !tilesLoaded,
    tilesStalled,
  );
}

function readyRetry(tilesStalled) {
  return shouldOfferMapRetry({
    mapState: 'ready',
    tileErrorCount: 0,
    fitFailed: false,
    fitPending: false,
    zeroHeight: false,
    zeroWidth: false,
    hasOtherResource: false,
    recentreFailed: false,
    contextLost: false,
    tilesStalled,
  });
}

test('v34 B1: ready map with tiles NOT loaded never claims "Map ready"', () => {
  const pill = readyPill(false, false);
  assert.equal(pill, 'Loading map tiles…');
});

test('v34 B1: ready map with stalled tiles names the failure + Retry', () => {
  const pill = readyPill(false, true);
  assert.equal(pill, 'Map tiles not loading — try Retry');
});

test('v34 B1: ready map WITH tiles loaded still reads "Map ready"', () => {
  assert.equal(readyPill(true, false), 'Map ready');
});

test('v34 B1: stalled tiles offer Retry; pending tiles do not', () => {
  assert.equal(readyRetry(true), true);
  assert.equal(readyRetry(false), false);
});

test('v34 B1: tiles watchdog fires at exactly TILE_STALL_MS (10 s)', () => {
  assert.equal(TILE_STALL_MS, 10_000);
  const readyAt = 1_000_000;
  assert.equal(tilesStalledAfterMs(readyAt, readyAt + 9_999), false);
  assert.equal(tilesStalledAfterMs(readyAt, readyAt + 10_000), true);
  assert.equal(tilesStalledAfterMs(readyAt, readyAt + 60_000), true);
  assert.equal(tilesStalledAfterMs(0, readyAt + 60_000), false);
});

test('v34 B1: PlayMap wires the real tiles signal (idle + areTilesLoaded)', () => {
  assert.ok(
    playMapSrc.includes("map.on('idle'"),
    'PlayMap must listen for the MapLibre idle event',
  );
  assert.ok(
    playMapSrc.includes('areTilesLoaded'),
    'PlayMap must backstop idle with areTilesLoaded()',
  );
  assert.ok(
    playMapSrc.includes('tilesStalledAfterMs'),
    'PlayMap must run the tiles watchdog',
  );
  assert.ok(
    playMapSrc.includes('!tilesLoaded,') && playMapSrc.includes('tilesStalled,'),
    'PlayMap must pass the tiles flags into the pill',
  );
});
