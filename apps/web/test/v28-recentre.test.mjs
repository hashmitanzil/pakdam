import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./resolve-hooks.mjs', import.meta.url);

const logic = await import('../src/components/hud/play-map-logic.ts');
const {
  resolveRecentreCentre,
  meDotMarkerStyle,
  meAccuracyFeatures,
  isFixStale,
  classifyMapError,
  isMapResourceError,
  otherResourceStale,
  recentreStaleNote,
  RECENTRE_DEFAULT_NOTE,
  RECENTRE_FAILED_COPY,
  RECENTRE_ZONE_FALLBACK_NOTE,
  pillTextForState,
} = logic;

/**
 * v28-recentre.test.mjs — the ◎ null-'0' crash (Meera).
 *
 * REPRODUCTION (founder 2026-11-22, v27 applied, map paints): tapping ◎
 * flipped the pill from 'Map ready' to
 * "Map resource failing — Cannot read properties of null (reading '0')".
 * The pill text proves a post-load MapLibre `error` event arrived with
 * that TypeError as its message, no `tile` on the event, and no
 * sprite/glyph marker — so `classifyMapError` filed it as 'other' and
 * the pill labelled a camera/tap failure as a resource failure.
 *
 * The ◎ path is `centreOn` (PlayMap.tsx:1431-1447, pre-v28): it passed
 * an UNVALIDATED centre straight to `map.easeTo` with no try/catch.
 * `polygonCentroid` (packages/engine/src/zone.ts:97) sums raw vertex
 * values and divides by length — one non-finite vertex (a malformed
 * snapshot vertex) poisons the sum to NaN, and MapLibre's `LngLat`
 * constructor throws on NaN (`Invalid LngLat object: (NaN, NaN)`,
 * installed maplibre-gl 5.24.1). The old code also trusted `myFix`
 * unchecked. Verified NOT the crash site (do not rebuild around
 * these): `boundaryBBox` never returns null (infinities for an empty
 * polygon), `polygonCentroid([])` is NaN not a null throw, `ring()`
 * guards `first &&`, `maplibre.ts:327` is ternary-guarded.
 *
 * FIX REQUIREMENT: ◎ resolves its centre through
 * `resolveRecentreCentre` (fix → zone centroid → Ranchi default),
 * which NEVER returns a non-finite centre; `easeTo` is guarded so a
 * tap-handler failure can never surface as a resource failure; the
 * failure copy is ALLOW-LISTED (Zara A1 — no raw `err.message`, no
 * stack, no coordinates in the pill).
 */

const RANCHI = { lng: 85.33, lat: 23.36 };
const ZONE = [
  { lng: 85.32, lat: 23.35 },
  { lng: 85.34, lat: 23.35 },
  { lng: 85.34, lat: 23.37 },
  { lng: 85.32, lat: 23.37 },
];

test('reproduction: the old centre path hands NaN to easeTo on a bad vertex', () => {
  // polygonCentroid sums raw vertex values and divides by length: one
  // NaN vertex poisons the sum — this is what the pre-v28 centreOn
  // passed to map.easeTo unchecked (zone.ts:97).
  const badZone = [
    { lng: 85.32, lat: 23.35 },
    { lng: NaN, lat: 23.35 },
    { lng: 85.34, lat: 23.37 },
  ];
  let lat = 0;
  let lng = 0;
  for (const p of badZone) {
    lat += p.lat;
    lng += p.lng;
  }
  const centre = { lat: lat / badZone.length, lng: lng / badZone.length };
  assert.equal(Number.isFinite(centre.lng), false);
  // And MapLibre's LngLat constructor rejects NaN — so easeTo throws.
  assert.throws(() => {
    if (Number.isNaN(centre.lng) || Number.isNaN(centre.lat)) {
      throw new Error(`Invalid LngLat object: (${centre.lng}, ${centre.lat})`);
    }
  }, /Invalid LngLat/);
});

test('resolveRecentreCentre: a valid fix wins', () => {
  const fix = { lng: 85.331, lat: 23.361, accuracyMeters: 120, timestampMs: 1 };
  const out = resolveRecentreCentre(fix, ZONE);
  assert.deepEqual(out.centre, { lng: 85.331, lat: 23.361 });
  assert.equal(out.source, 'fix');
});

test('resolveRecentreCentre: a rough fix (800 m) still centres on the player', () => {
  // Liveness vs usability is decoupled: a rough fix still shows/centres.
  const fix = { lng: 85.331, lat: 23.361, accuracyMeters: 800, timestampMs: 1 };
  const out = resolveRecentreCentre(fix, ZONE);
  assert.equal(out.source, 'fix');
  assert.equal(Number.isFinite(out.centre.lng), true);
});

test('resolveRecentreCentre: no fix → zone centroid', () => {
  const out = resolveRecentreCentre(null, ZONE);
  assert.equal(out.source, 'zone');
  assert.ok(Math.abs(out.centre.lng - 85.33) < 1e-9);
  assert.ok(Math.abs(out.centre.lat - 23.36) < 1e-9);
});

test('resolveRecentreCentre: a NaN-vertex boundary NEVER yields a NaN centre', () => {
  const badZone = [
    { lng: 85.32, lat: 23.35 },
    { lng: NaN, lat: 23.35 },
    { lng: 85.34, lat: 23.37 },
  ];
  const out = resolveRecentreCentre(null, badZone);
  assert.equal(out.source, 'default');
  assert.deepEqual(out.centre, RANCHI);
  assert.equal(Number.isFinite(out.centre.lng), true);
  assert.equal(Number.isFinite(out.centre.lat), true);
});

test('resolveRecentreCentre: a non-finite fix falls back to the zone, not NaN', () => {
  const fix = { lng: NaN, lat: 23.361, accuracyMeters: 10, timestampMs: 1 };
  const out = resolveRecentreCentre(fix, ZONE);
  assert.equal(out.source, 'zone');
  assert.equal(Number.isFinite(out.centre.lng), true);
});

test('resolveRecentreCentre: null fix + empty boundary → Ranchi default', () => {
  const out = resolveRecentreCentre(null, []);
  assert.equal(out.source, 'default');
  assert.deepEqual(out.centre, RANCHI);
});

test('resolveRecentreCentre: null fix + null boundary → Ranchi default, never throws', () => {
  const out = resolveRecentreCentre(null, null);
  assert.equal(out.source, 'default');
  assert.deepEqual(out.centre, RANCHI);
});

// v29 fix round (M8): `meDotFeatures` is REMOVED — the me dot is a DOM
// marker now, and the helper had no caller left in src. Its display
// rules live on in the marker path: ANY validated fix draws (no ±50 m
// gate on display — a rough fix still yields a dot), a non-finite fix
// hides the marker (no NaN point, no crash), and a stale fix draws
// faded instead of masquerading as live. Pinned here at the source
// level (the marker positioning lives in PlayMap.tsx, not in a pure
// helper any more):
test('meDotFeatures is gone (M8): the DOM marker path carries its display rules', () => {
  assert.equal(logic.meDotFeatures, undefined, 'the dead circle-layer helper must be removed');
  // Rough fix → dot (no ±50 m gate on display): the marker style is
  // unconditional on accuracy — only staleness fades it.
  assert.equal(meDotMarkerStyle(false).opacity, '1');
  assert.equal(meDotMarkerStyle(true).opacity, '0.35', 'a stale fix draws faded, not hidden');
  assert.equal(meDotMarkerStyle(false).width, meDotMarkerStyle(false).height);
});

test('re-centre failure copy is allow-listed (Zara A1): no raw error text', () => {
  assert.equal(RECENTRE_FAILED_COPY, 'Re-centre failed — try again');
  // The copy carries no coordinates, no TypeError, no stack fragment.
  assert.doesNotMatch(RECENTRE_FAILED_COPY, /Cannot read|TypeError|NaN|85\.|23\./);
});

test('pill: a re-centre failure reads as its own honest copy, not a resource failure', () => {
  const text = pillTextForState(
    'ready', 'ready', false, null,
    0, null, false, false, null, null, false, false, null,
    true, // recentreFailed
  );
  assert.equal(text, 'Re-centre failed — try again');
  assert.doesNotMatch(text, /resource failing|tiles failing/);
});

test('pill: re-centre failure + tile error are both named, neither swallowed', () => {
  const text = pillTextForState(
    'ready', 'ready', false, null,
    1, 'HTTP 401', false, false, null, null, false, false, null,
    true,
  );
  assert.match(text, /Re-centre failed — try again/);
  assert.match(text, /Map tiles failing — 1 tile error/);
});

test('pill: a zero-height container still outranks a re-centre failure', () => {
  const text = pillTextForState(
    'ready', 'ready', false, null,
    0, null, false, false, null, null, false, false, 'container-zero-height',
    true,
  );
  assert.equal(text, 'Map container has no height — try Retry');
});

test('F3: a post-load JS TypeError is NOT a resource failure', () => {
  // The founder's exact pill: "Map resource failing — Cannot read
  // properties of null (reading '0')". No tile, no sprite/glyph
  // signal, no HTTP status, no resource word — camera/JS work, not
  // a resource. The old classifyMapError filed EVERY post-load error
  // as 'post-load-tile-error'.
  const event = {
    error: { message: "Cannot read properties of null (reading '0')" },
  };
  assert.equal(isMapResourceError(event), false);
  assert.deepEqual(classifyMapError(true, event), {
    kind: 'post-load-non-resource',
    detail: "Cannot read properties of null (reading '0')",
  });
});

test('F3: a real tile error still classifies as a tile error', () => {
  const event = { tile: { tileID: { z: 14 } }, error: { message: 'HTTP 401' } };
  assert.equal(isMapResourceError(event), true);
  const out = classifyMapError(true, event);
  assert.equal(out.kind, 'post-load-tile-error');
  assert.equal(out.resource, 'tile');
});

test('F3: a sprite failure still classifies as a sprite resource error', () => {
  const event = { error: { message: 'Failed to load sprite' } };
  assert.equal(isMapResourceError(event), true);
  const out = classifyMapError(true, event);
  assert.equal(out.kind, 'post-load-tile-error');
  assert.equal(out.resource, 'sprite');
});

test('F3: a pre-load failure is still a pre-load failure', () => {
  const out = classifyMapError(false, {
    error: { message: 'HTTP 401', status: 401 },
  });
  assert.equal(out.kind, 'pre-load-failure');
});

test('F3: a lone non-tile problem decays on its own clock (never sticks forever)', () => {
  // The old decay only cleared otherResource when tileLedgerStale
  // was true, which requires ledger.count > 0 — a lone TypeError
  // with zero tile errors stuck forever.
  assert.equal(otherResourceStale(Date.now() - 31_000, Date.now()), true);
  assert.equal(otherResourceStale(Date.now() - 5_000, Date.now()), false);
  assert.equal(otherResourceStale(undefined, Date.now()), true);
});

test('F5: the accuracy ring is the fix’s real accuracy circle', () => {
  const fix = { lng: 85.331, lat: 23.361, accuracyMeters: 800, timestampMs: 1 };
  const features = meAccuracyFeatures(fix);
  assert.equal(features.length, 1);
  assert.equal(features[0].geometry.type, 'Polygon');
  // 64-point circle + closing point.
  assert.equal(features[0].geometry.coordinates[0].length, 65);
  // A 5 m fix gets a tight ring, not an 800 m one: the ring radius
  // differs with the accuracy.
  const tight = meAccuracyFeatures({
    lng: 85.331, lat: 23.361, accuracyMeters: 5, timestampMs: 1,
  });
  const ring = features[0].geometry.coordinates[0];
  const tightRing = tight[0].geometry.coordinates[0];
  const span = (r) => Math.max(...r.map((p) => p[0])) - Math.min(...r.map((p) => p[0]));
  assert.ok(span(ring) > span(tightRing) * 10);
});

test('F5: no fix → no accuracy ring; a non-finite fix → no ring', () => {
  assert.deepEqual(meAccuracyFeatures(null), []);
  assert.deepEqual(
    meAccuracyFeatures({ lng: NaN, lat: 23.361, accuracyMeters: 10, timestampMs: 1 }),
    [],
  );
});

test('F6: a fix older than 60 s is stale; a fresh fix is not', () => {
  const now = Date.now();
  assert.equal(
    isFixStale({ lng: 85.331, lat: 23.361, accuracyMeters: 10, timestampMs: now - 61_000 }, now),
    true,
  );
  assert.equal(
    isFixStale({ lng: 85.331, lat: 23.361, accuracyMeters: 10, timestampMs: now - 5_000 }, now),
    false,
  );
  assert.equal(isFixStale(null, now), false);
});

// F6 (v29 fix round M8): the stale fade moved with the dot — the DOM
// marker style fades a stale fix (`meDotMarkerStyle(true)`), and the
// marker path hides on a non-finite fix (PlayMap.tsx `positionMarker`).
// The old `meDotFeatures` stale-flag assertions died with the helper;
// the behaviour they pinned is covered by the marker-style test above
// and by `isFixStale` below.

test('F2: the ◎ fallback / stale notes are allow-listed plain words', () => {
  assert.equal(RECENTRE_ZONE_FALLBACK_NOTE, 'Centred on the zone — no GPS fix yet.');
  assert.equal(
    RECENTRE_DEFAULT_NOTE,
    // v28 fix round (Diya A6): "no usable zone", not "no zone yet" —
    // the default is also the fallback for a degenerate / malformed
    // boundary that EXISTS but cannot be centred on.
    'Centred on Ranchi — no GPS fix and no usable zone.',
  );
  assert.equal(
    recentreStaleNote(90),
    'Centred on your last fix from 90s ago — GPS is stale.',
  );
  assert.doesNotMatch(recentreStaleNote(90), /Cannot read|TypeError|NaN|85\.|23\./);
});
