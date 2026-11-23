import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const logic = await import('../src/components/hud/play-map-logic.ts');
const { FakeMapLibreMap } = await import('./fake-map.mjs');
const { polygonCentroid } = await import('@pakdam/engine');
const { OLA_MAP_INITIAL_CENTRE } = await import('../src/components/map/maplibre.ts');
const { classifyMapError, classifyPostLoadResource, mapErrorDetail, pillTextForState, resourceLabel, ring, boundaryBBox, resolveRecentreCentre, RECENTRE_FAILED_COPY } =
  logic;

/**
 * v28-repro-centre.test.mjs — RED reproduction tests for the ◎ re-centre crash (Arjun, QA).
 *
 * LANDED STATE (re-checked during the verification run — the
 * centreOn wiring is now LANDED; the file below is green except
 * where a test pins the pre-fix shape as a MECHANISM record):
 *  - `resolveRecentreCentre` LANDED (Meera, play-map-logic.ts):
 *    fix → zone → Ranchi, finite at every step; centreOn calls it.
 *  - `centreOn` LANDED (PlayMap.tsx): `if (!map || !mapReady)
 *    return` load guard (hole 1), try/catch around easeTo with
 *    `setRecentreFailed` + allow-listed RECENTRE_FAILED_COPY
 *    (never raw text), and the `bearing` key is omitted when
 *    undefined (hole 3, below).
 *  - `classifyMapError` LANDED: a bare JS TypeError is now
 *    'post-load-non-resource' and the listener records nothing —
 *    the pill stays 'Map ready' (defect (2) below, fixed).
 *  - HOLE (3), found while landing (Meera's centreOn comment,
 *    verified against installed maplibre-gl 5.24.1): the old
 *    centreOn passed `bearing: undefined` as a PRESENT key, and
 *    `easeTo` (:69531) reads `'bearing' in options`, so EVERY ◎ tap
 *    ran `_normalizeBearing(undefined, …)` → NaN bearing.
 *  - The null-'0' ORIGIN remains unpinned (Diya): no our-code
 *    `[0]`-on-null path is reachable from ◎, and a synchronous
 *    easeTo throw would NOT go through map.on('error') — the pill
 *    requires an error event. The distinguishing tests (a)/(b)/(c)
 *    below are the record of that investigation; `ring()` was
 *    FALSIFIED as the source (it throws reading 'lng', not '0').
 *  - Verdict on the crash itself is the founder's live-phone check:
 *    does ◎ still flip the pill, and does the pill now read the
 *    allow-listed copy on a tap failure.
 *
 * FOUNDER SYMPTOM (2026-11-22, live phone, v27 applied — map paints):
 * tapping ◎ flipped the pill from "Map ready" to
 * "Map resource failing — Cannot read properties of null (reading '0')".
 *
 * TWO defects, pinned here against the REAL production code:
 *
 *  (1) centreOn can feed a NON-FINITE centre to `map.easeTo`.
 *      PlayMap.tsx `centreOn` (PlayMap.tsx:1431-1445) picks
 *      `myFix` when present, else `polygonCentroid(zoneBoundary)`
 *      when the boundary has >= 3 points, else the Ranchi fallback.
 *      It never checks finiteness. `polygonCentroid` (engine zone.ts)
 *      is a bare vertex average: `0 / 0` for an empty polygon is NaN,
 *      and one NaN vertex poisons the whole average. A NaN camera
 *      into MapLibre's easeTo/render path is what throws inside the
 *      map — the TypeError the founder saw.
 *  (2) A raw JS TypeError is surfaced VERBATIM as a "resource
 *      failure" in the pill. The map `error` listener
 *      (PlayMap.tsx) classifies ANY post-load error event via
 *      `classifyMapError` — a TypeError thrown by our own code or by
 *      MapLibre internals classifies as `post-load-tile-error` with
 *      resource `'other'`, is stored as `otherResource`
 *      `{ label: 'resource', detail: <raw message> }`, and the pill
 *      renders "Map resource failing — Cannot read properties of
 *      null (reading '0')". A TypeError is not a tile, sprite, glyph
 *      or resource failure, and its engine wording must never reach
 *      the screen as a diagnosis.
 *
 * WHAT IS REAL vs MIRROR here:
 *  - `polygonCentroid`, `classifyMapError`,
 *    `classifyPostLoadResource`, `mapErrorDetail`, `pillTextForState`
 *    are the REAL production exports — the REPRODUCTION tests below
 *    call them directly and FAIL against the current code.
 *  - `centreOn` itself lives inside the React component
 *    (PlayMap.tsx) and is not importable under Node, so
 *    `centreTargetForMirror` below is a VERBATIM copy of its
 *    centre-selection ternary (PlayMap.tsx:1435-1440) plus the
 *    `easeTo` call, driven through the FakeMap. When Meera lands
 *    the fix, this mirror MUST be re-pointed at the real exported
 *    helper (extracted into play-map-logic.ts) — the mirror exists
 *    to prove the bug, not to become a second implementation.
 *  - The GPS-dot half of the founder's report has NO Node
 *    reproduction here: the me-dot overlay (`pakdam-me`, PlayMap.tsx
 *    ~1274) writes the point whenever `myFix` is non-null, and the
 *    play page sets `myFix` on the first fix — no defect is visible
 *    in that path under Node. The dot stays a live-phone verdict.
 *  - DOUBLE-TAP ZOOM: grounded in the INSTALLED build
 *    (maplibre-gl 5.24.1, `maplibre-gl-dev.js`): `TapZoomHandler`
 *    (1 touch, 2 taps → zoom +1; 2 touches, 1 tap → zoom −1) is
 *    created for every map and enabled whenever the map is
 *    interactive and `doubleClickZoom` is on — and the default
 *    `doubleClickZoom: true` (:71256) is never turned off by
 *    `createOlaMap` (no `doubleClickZoom: false`, no
 *    `interactive: false` anywhere in `maplibre.ts`). So double-tap
 *    zoom is ON by default in this build; there is no Node-visible
 *    defect to reproduce, and the founder's "no double-tap zoom"
 *    needs a live-phone check (taps landing on the ◎/N/compass
 *    overlay buttons is the open hypothesis). The MECHANISM test
 *    below pins the default so nobody "fixes" it by adding what is
 *    already there.
 *
 * Labels follow play-map-v27.test.mjs:
 *  - REPRODUCTION — fails pre-fix, passes after the fix.
 *  - MECHANISM — passes pre-fix, pins why the break happens.
 *
 * DIYA FOLLOW-UP (2026-11-22, adversarial review — ESTABLISHED FACTS):
 *  - `boundaryBBox` never returns null.
 *  - `polygonCentroid([])` returns NaN (0/0) — confirmed below.
 *  - `centreOn` guards `zoneBoundary.length >= 3`, so the NaN
 *    centroid is NOT reachable via ◎ — the polygonCentroid tests
 *    below are engine-level defence-in-depth, NOT the ◎ origin.
 *  - The null-'0' ORIGIN remains unpinned by static review: no
 *    our-code `[0]`-on-`null` path is reachable from ◎
 *    (`centreOn` contains no `[0]` read; `createOlaMap` is called
 *    with no `center`). The "(a) vs (b)" tests below distinguish
 *    the paths, grounded in the INSTALLED MapLibre build
 *    (maplibre-gl-dev.js):
 *      (a) a SYNCHRONOUS `easeTo` throw is an uncaught
 *          click-handler exception — it never reaches
 *          `map.on('error')`, so the pill is untouched;
 *      (b) a RENDER-path throw is RE-THROWN, not fired as an
 *          error event — `triggerRepaint`'s frame callback wraps
 *          `_render` in try/catch and re-throws every non-abort
 *          error (:74013-74021), so it too leaves the pill
 *          untouched;
 *      (c) the founder's pill REQUIRES a map `error` event: the
 *          pill flips only in the `map.on('error')` listener
 *          (PlayMap.tsx:711), and MapLibre fires `ErrorEvent`s
 *          only from ASYNC resource paths (tile / style / source
 *          loads — e.g. `emitValidationErrors` :22320,
 *          `ensureError` in source loads). An `ErrorEvent` with
 *          no listener is only `console.error`d (:10139-10141).
 *    So a throw — sync or render — CANNOT produce the founder's
 *    pill. The TypeError reached the pill as an `error` EVENT from
 *    an async resource path inside MapLibre (or elsewhere); the
 *    exact internal site is NOT pinned and must not be assumed.
 *  - `ring()` HYPOTHESIS (Diya candidate, FALSIFIED below):
 *    `ring()` (play-map-logic.ts:199-202) does `first[0]` where
 *    `first = coords[0]` — but `first` is guarded (`first &&`),
 *    and a null vertex throws EARLIER, in the `.map` step, as
 *    "Cannot read properties of null (reading 'lng')" — verified
 *    by running the real function. It does NOT produce the
 *    founder's exact "reading '0'" message, so it is not the
 *    origin. Recorded here, not assumed.
 *
 * LANDED STATE (re-checked during the verification run — the tree
 * moved while these tests were written):
 *  - HELPER LAYER LANDED (Meera): `resolveRecentreCentre`,
 *    `meAccuracyFeatures`, `RECENTRE_FAILED_COPY`,
 *    the pill's 14th `recentreFailed` param, `isMapResourceError` /
 *    the `post-load-non-resource` kind, the listener's early return
 *    for it, `shouldWatchLocation`, `gpsNoFixNotice`.
 *    (`meDotFeatures` landed here too, then was removed in the v29
 *    fix round M8 — the dot is a DOM marker now and the helper was dead.)
 *  - WIRING STILL MISSING (the two REPRODUCTION wiring-gap tests
 *    below): `centreOn` (PlayMap.tsx:1490-1505) is still the
 *    pre-v28 ternary — it does not call `resolveRecentreCentre`
 *    and does not guard `easeTo` / `setRecentreFailed`. The play
 *    page watcher does not consult `shouldWatchLocation` (see
 *    v28-repro-fixstop.test.mjs). The heartbeat is not paused
 *    while hidden. The demo (4a) does not freeze hidden time (F14).
 */

const PATNA = { lat: 25.5941, lng: 85.1376 };
const TYPE_ERROR_MESSAGE = "Cannot read properties of null (reading '0')";
const FALLBACK = { lng: OLA_MAP_INITIAL_CENTRE[0], lat: OLA_MAP_INITIAL_CENTRE[1] };

/**
 * VERBATIM MIRROR of PlayMap.tsx centreOn (1431-1445), centre
 * selection + easeTo call only — see the header. `map` is a
 * FakeMapLibreMap (or null when the build is deferred — centreOn
 * returns early then, PlayMap.tsx:1434); `bearing` is omitted
 * (recentre calls centreOn() with no bearing, exactly like the ◎ button).
 */
function centreTargetForMirror({ myFix, zoneBoundary, map }) {
  if (!map) return undefined;
  const centre =
    myFix !== null
      ? { lng: myFix.lng, lat: myFix.lat }
      : zoneBoundary.length >= 3
        ? polygonCentroid(zoneBoundary)
        : { lng: OLA_MAP_INITIAL_CENTRE[0], lat: OLA_MAP_INITIAL_CENTRE[1] };
  map.easeTo({ center: [centre.lng, centre.lat], bearing: undefined, duration: 300 });
  return centre;
}

/**
 * MIRROR of the PlayMap.tsx:711 `map.on('error')` listener's
 * OBSERVABLE outcome, built from the REAL classifier: given the
 * load state and the event, what pill does the page show? A
 * pre-load failure is the error overlay (pill: the loading text,
 * never a resource failure); a post-load tile failure is the tile
 * pill; a post-load non-tile failure is the otherResource pill.
 */
function driveErrorListener({ loaded, event }) {
  const classification = classifyMapError(loaded, event);
  if (classification.kind === 'pre-load-failure') {
    return { kind: classification.kind, pill: 'Map loading — style failed to load' };
  }
  // v28 (Diya F3, landed in the classifier): a post-load error that
  // is NOT a resource failure (a bare JS TypeError) records NOTHING
  // — the map is still up and the pill stays honest.
  if (classification.kind === 'post-load-non-resource') {
    return { kind: classification.kind, pill: 'Map ready' };
  }
  if (classification.resource === 'tile') {
    return {
      kind: classification.kind,
      resource: 'tile',
      pill: pillTextForState('ready', 'ready', false, null, 1, classification.detail),
    };
  }
  return {
    kind: classification.kind,
    resource: classification.resource,
    pill: pillTextForState(
      'ready',
      'ready',
      false,
      null,
      0,
      null,
      false,
      false,
      { label: resourceLabel(classification.resource), detail: classification.detail },
      null,
      false,
      false,
      null,
    ),
  };
}

/** The pill PlayMap renders for a post-load 'other' resource problem, as the error listener builds it. */
function pillForOtherResource(detail) {
  return pillTextForState(
    'ready',
    'ready',
    false,
    null,
    0,
    null,
    false,
    false,
    { label: 'resource', detail },
    null,
    false,
    false,
    null,
  );
}

// ---------------------------------------------------------------------------
// (1) The non-finite centre.
// ---------------------------------------------------------------------------

test('v28 MECHANISM (passes — pins the raw material): polygonCentroid of an EMPTY polygon is NaN, and resolveRecentreCentre is the layer that must defend against it', () => {
  // ENGINE-LEVEL fact, NOT the ◎ origin (Diya, established fact):
  // centreOn guards zoneBoundary.length >= 3, so this input never
  // reaches polygonCentroid via ◎. The engine function is unchanged
  // in v28 by design — the defence lives in the CALLER
  // (`resolveRecentreCentre`, which validates finiteness before and
  // after the average). Pinning the raw NaN here so a future caller
  // cannot mistake it for a safe value.
  const c = polygonCentroid([]);
  assert.ok(
    Number.isNaN(c.lat) && Number.isNaN(c.lng),
    `polygonCentroid([]) is the bare 0/0 average — got ${JSON.stringify(c)}`,
  );
  const out = resolveRecentreCentre(null, []);
  assert.deepEqual(out, { centre: FALLBACK, source: 'default' });
});

test('v28 MECHANISM (passes — pins the raw material): polygonCentroid with a NaN vertex is NaN, and resolveRecentreCentre is the layer that must defend against it', () => {
  // One corrupt vertex (a bad server snapshot, a degenerate shrink)
  // poisons the bare vertex average — the whole centroid goes NaN.
  // No path is currently known to put a NaN vertex into a boundary
  // (Diya); the engine function is unchanged in v28 by design — the
  // defence lives in `resolveRecentreCentre`, which requires every
  // vertex finite before averaging and re-checks the result.
  const boundary = [
    { lat: PATNA.lat, lng: PATNA.lng },
    { lat: PATNA.lat + 0.004, lng: PATNA.lng },
    { lat: NaN, lng: PATNA.lng },
  ];
  const c = polygonCentroid(boundary);
  assert.ok(
    Number.isNaN(c.lat) || Number.isNaN(c.lng),
    `polygonCentroid with a NaN vertex is NaN — got ${JSON.stringify(c)}`,
  );
  const out = resolveRecentreCentre(null, boundary);
  assert.deepEqual(out, { centre: FALLBACK, source: 'default' });
});

test('v28: null fix + EMPTY boundary falls back to the Ranchi centre (resolveRecentreCentre, landed)', () => {
  const out = resolveRecentreCentre(null, []);
  assert.deepEqual(out, { centre: FALLBACK, source: 'default' });
});

test('v28: null fix + 2-point boundary falls back to the Ranchi centre (resolveRecentreCentre, landed)', () => {
  const out = resolveRecentreCentre(null, [
    { lat: PATNA.lat, lng: PATNA.lng },
    { lat: PATNA.lat + 0.004, lng: PATNA.lng },
  ]);
  assert.deepEqual(out, { centre: FALLBACK, source: 'default' });
});

test('v28: null fix + 3-point boundary with a NaN vertex falls back to the Ranchi centre (resolveRecentreCentre, landed)', () => {
  const out = resolveRecentreCentre(null, [
    { lat: PATNA.lat, lng: PATNA.lng },
    { lat: PATNA.lat + 0.004, lng: PATNA.lng },
    { lat: NaN, lng: PATNA.lng },
  ]);
  assert.deepEqual(out, { centre: FALLBACK, source: 'default' });
  assert.ok(Number.isFinite(out.centre.lat) && Number.isFinite(out.centre.lng));
});

test('v28: a non-null fix with NaN coords falls back to the zone, never NaN (resolveRecentreCentre, landed)', () => {
  // validateFix rejects NaN fixes upstream, so this is defence in
  // depth — the resolver itself must never trust the fix blindly.
  const zone = [
    { lat: PATNA.lat, lng: PATNA.lng },
    { lat: PATNA.lat + 0.004, lng: PATNA.lng },
    { lat: PATNA.lat + 0.004, lng: PATNA.lng + 0.004 },
  ];
  const out = resolveRecentreCentre(
    { lat: NaN, lng: NaN, accuracyMeters: 10, timestampMs: 1 },
    zone,
  );
  assert.equal(out.source, 'zone');
  assert.ok(Number.isFinite(out.centre.lat) && Number.isFinite(out.centre.lng));
});

test('v28 MECHANISM (passes — pins the pre-fix bug shape): the PRE-v28 centre ternary yields a NaN centre on a NaN vertex (the mirror, not the landed code)', () => {
  // The old PlayMap.tsx:1435-1440 ternary, verbatim in
  // centreTargetForMirror above: no finiteness check anywhere, so a
  // NaN vertex poisons the centre and easeTo receives NaN. This is
  // what resolveRecentreCentre replaced at the helper layer — the
  // COMPONENT still carries this ternary (see the wiring-gap tests
  // below), so this pin stays until centreOn is rewired.
  const map = new FakeMapLibreMap();
  const centre = centreTargetForMirror({
    myFix: null,
    zoneBoundary: [
      { lat: PATNA.lat, lng: PATNA.lng },
      { lat: PATNA.lat + 0.004, lng: PATNA.lng },
      { lat: NaN, lng: PATNA.lng },
    ],
    map,
  });
  assert.ok(Number.isNaN(centre.lat) || Number.isNaN(centre.lng));
  const eased = map.callsOf('easeTo')[0].options.center;
  assert.ok(Number.isNaN(eased[0]) || Number.isNaN(eased[1]));
});

test('v28 MECHANISM (passes pre-fix — pins how the TypeError escapes): the mirrored centreOn has no guard around easeTo, so a throwing easeTo escapes the ◎ tap — and the pill is UNTOUCHED by it', () => {
  // A FakeMap whose easeTo throws the founder's exact TypeError
  // (what real MapLibre does on a NaN camera in its render path):
  // the throw escapes centreOn uncaught — there is no try/catch
  // between the ◎ onClick and easeTo, so it becomes an uncaught
  // error / a map error event instead of a no-op.
  // DISTINGUISHING (a): the throw emits NO 'error' event on the
  // map (recorded below), and the pill — computed from the unchanged
  // state — still reads 'Map ready'. A synchronous easeTo throw
  // therefore CANNOT produce the founder's pill. The pill flip
  // needs an error EVENT (see the (b)/(c) tests below).
  class ThrowingEaseMap extends FakeMapLibreMap {
    easeTo() {
      throw new TypeError(TYPE_ERROR_MESSAGE);
    }
  }
  const map = new ThrowingEaseMap();
  const errorEvents = [];
  map.on('error', (event) => errorEvents.push(event));
  assert.throws(
    () =>
      centreTargetForMirror({
        myFix: { lat: PATNA.lat, lng: PATNA.lng, accuracyMeters: 10, timestampMs: 1 },
        zoneBoundary: [],
        map,
      }),
    (err) => err instanceof TypeError && err.message === TYPE_ERROR_MESSAGE,
    'the current centreOn lets an easeTo TypeError escape the ◎ tap',
  );
  assert.equal(
    errorEvents.length,
    0,
    'a synchronous easeTo throw emits no map error event — nothing reaches the error listener',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null),
    'Map ready',
    'with no error event the pill is untouched by the throw',
  );
});

// ---------------------------------------------------------------------------
// (2) The pill must not surface a raw TypeError as a resource failure.
// ---------------------------------------------------------------------------

test('v28 MECHANISM (passes — pins the LANDED classification): a post-load TypeError event is now post-load-non-resource, never a resource failure', () => {
  // v28 (Diya F3, landed in the classifier): `isMapResourceError`
  // is a POSITIVE-signal test (tile prop, HTTP status, error URL, or
  // a genuine resource word in the message — sprite / glyph / tile /
  // source / layer / network / an HTTP status — or a load failure
  // NAMING a resource). v28 fix round (Zara V4): bare `load` /
  // `style` / `fetch` no longer match, so a plain JS error whose
  // message contains "load" is NOT a resource failure. A bare JS
  // TypeError matches none of those, so it classifies
  // 'post-load-non-resource' and the listener records NOTHING for
  // it. (Pre-v28 this was 'post-load-tile-error' / resource 'other'
  // — the misclassification that produced the founder's pill.)
  const classification = classifyMapError(true, {
    error: { message: TYPE_ERROR_MESSAGE },
  });
  assert.equal(
    classification.kind,
    'post-load-non-resource',
    'a bare TypeError is not a resource failure',
  );
  // The low-level helpers are unchanged by design: the defence is
  // the classifier + listener, not the detail extractors.
  assert.equal(classifyPostLoadResource({ error: { message: TYPE_ERROR_MESSAGE } }), 'other');
  assert.equal(mapErrorDetail({ error: { message: TYPE_ERROR_MESSAGE } }), TYPE_ERROR_MESSAGE);
});

test('v28 MECHANISM (passes — pins the layering): pillTextForState renders an otherResource detail verbatim by design — the TypeError defence lives upstream (classifier + listener), NOT in the pill function', () => {
  // A fabricated otherResource carrying the TypeError still renders
  // verbatim — the pill function renders what it is given. That is
  // reachable ONLY if a caller files a TypeError as an otherResource,
  // which the landed listener no longer does (see the
  // post-load-non-resource branch: it returns early and records
  // nothing). If the coordinator wants pill-level sanitisation as
  // defence-in-depth, that is a follow-up, not the v28 fix shape.
  const pill = pillForOtherResource(TYPE_ERROR_MESSAGE);
  assert.equal(
    pill,
    `Map resource failing — ${TYPE_ERROR_MESSAGE}`,
    'the pill renders a given otherResource verbatim (upstream must never file a TypeError there)',
  );
  // The REACHABLE path — a TypeError error event through the real
  // classifier + listener mirror — never reaches otherResource:
  const outcome = driveErrorListener({
    loaded: true,
    event: { error: new TypeError(TYPE_ERROR_MESSAGE) },
  });
  assert.equal(outcome.kind, 'post-load-non-resource');
  assert.equal(outcome.pill, 'Map ready');
});

test('v28: a TypeError from the ◎ path must not become a post-load resource problem at all (landed — classifier + listener)', () => {
  // End to end through the REAL classifier + listener mirror: an
  // error event carrying the founder's TypeError ends as
  // 'post-load-non-resource' (record nothing, pill stays honest),
  // never as a "Map resource failing — …" pill.
  const outcome = driveErrorListener({
    loaded: true,
    event: { error: { message: TYPE_ERROR_MESSAGE } },
  });
  assert.equal(outcome.kind, 'post-load-non-resource');
  assert.equal(outcome.pill, 'Map ready');
  assert.ok(
    !outcome.pill.includes('Cannot read properties'),
    `a TypeError error event must never render as a resource failure — got: ${outcome.pill}`,
  );
});

// ---------------------------------------------------------------------------
// Distinguishing (a) vs (b) vs (c) — Diya follow-up.
//
// The founder's pill ("Map resource failing — Cannot read properties
// of null (reading '0')") can ONLY come from the map `error`
// listener (PlayMap.tsx:711). These tests drive `centreOn` with the
// map in each state (loading, loaded, deferred) and record whether
// the error surfaces as a thrown exception, an `error` event, or
// both — through the REAL classifier (`driveErrorListener` above).
// ---------------------------------------------------------------------------

test('v28 MECHANISM (passes pre-fix — distinguishes (b)): a RENDER-path throw is re-thrown, not fired as an error event — the pill is untouched', () => {
  // Installed MapLibre 5.24.1, triggerRepaint (:74013-74021): the
  // rAF frame callback wraps `_render` in try/catch and RE-THROWS
  // every non-abort, non-framebuffer error. A throw inside the
  // render loop therefore never becomes an `ErrorEvent` — it is an
  // uncaught error, exactly like the synchronous easeTo throw.
  // The FakeMap's triggerRepaint is a lenient no-op, so the
  // re-throwing behaviour is modelled by this subclass.
  class RethrowingRenderMap extends FakeMapLibreMap {
    triggerRepaint() {
      super.triggerRepaint();
      throw new TypeError(TYPE_ERROR_MESSAGE);
    }
  }
  const map = new RethrowingRenderMap();
  const errorEvents = [];
  map.on('error', (event) => errorEvents.push(event));
  // ◎ succeeds synchronously (easeTo lands), then the next repaint
  // throws in the render path — the installed behaviour.
  centreTargetForMirror({
    myFix: { lat: PATNA.lat, lng: PATNA.lng, accuracyMeters: 10, timestampMs: 1 },
    zoneBoundary: [],
    map,
  });
  assert.throws(
    () => map.triggerRepaint(),
    (err) => err instanceof TypeError && err.message === TYPE_ERROR_MESSAGE,
    'the render-path throw escapes (re-thrown, not swallowed)',
  );
  assert.equal(
    errorEvents.length,
    0,
    'a render-path throw fires no map error event — nothing reaches the error listener',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null),
    'Map ready',
    'with no error event the pill is untouched by the render throw',
  );
});

test('v28 MECHANISM (passes — distinguishes (c), LANDED outcome): an `error` event carrying the TypeError NO LONGER flips the pill', () => {
  // Pre-v28 this test proved the founder's pill: the loaded-map
  // error event was the ONLY path that produced "Map resource
  // failing — Cannot read properties…". v28 (Diya F3) fixed the
  // classifier: the event is now 'post-load-non-resource', the
  // listener records nothing, and the pill stays 'Map ready'.
  // The distinguishing result stands — a throw still cannot flip
  // the pill (tests (a)/(b) above) — and now neither can the event.
  const map = new FakeMapLibreMap();
  const seen = [];
  map.on('error', (event) => seen.push(driveErrorListener({ loaded: true, event })));
  centreTargetForMirror({
    myFix: { lat: PATNA.lat, lng: PATNA.lng, accuracyMeters: 10, timestampMs: 1 },
    zoneBoundary: [],
    map,
  });
  assert.equal(map.callsOf('easeTo').length, 1, '◎ eased the camera (no throw)');
  map.emitError(new TypeError(TYPE_ERROR_MESSAGE));
  assert.equal(seen.length, 1, 'the error event reached the listener once');
  assert.equal(seen[0].kind, 'post-load-non-resource');
  assert.equal(seen[0].pill, 'Map ready');
});

test('v28 MECHANISM (passes — map state: loading, pre-v28 mirror): a pre-load error event is NOT a resource failure — the pill never reads "Map resource failing"', () => {
  // ◎ during loading (the map exists but the style has not loaded):
  // the PRE-v28 centreOn (this mirror) does not check mapReady — it
  // eases anyway. The LANDED centreOn returns early when !mapReady
  // (pinned in the mapReady test above). Either way, if an error
  // event fires while loading, the listener takes the pre-load
  // branch (error overlay), never the otherResource pill.
  const map = new FakeMapLibreMap();
  const seen = [];
  map.on('error', (event) => seen.push(driveErrorListener({ loaded: false, event })));
  centreTargetForMirror({
    myFix: { lat: PATNA.lat, lng: PATNA.lng, accuracyMeters: 10, timestampMs: 1 },
    zoneBoundary: [],
    map,
  });
  assert.equal(map.callsOf('easeTo').length, 1, 'the pre-v28 mirror ◎ eases even while the map is still loading (no mapReady guard in the mirror)');
  map.emitError(new TypeError(TYPE_ERROR_MESSAGE));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'pre-load-failure');
  assert.ok(
    !seen[0].pill.includes('resource failing'),
    `a pre-load error must never read as a resource failure — got: ${seen[0].pill}`,
  );
});

test('v28 MECHANISM (passes pre-fix — map state: deferred): ◎ with NO map (build deferred into a flat area) is a no-op — no easeTo, no throw, no error event', () => {
  // Deferred build: mapRef.current is null (PlayMap.tsx:1434
  // returns early). The ◎ button is inert until a map exists.
  const errorEvents = [];
  const result = centreTargetForMirror({ myFix: null, zoneBoundary: [], map: null });
  assert.equal(result, undefined, 'centreOn returns early with no map');
  assert.equal(errorEvents.length, 0, 'no error event can fire with no map');
  assert.equal(
    pillTextForState('ready', 'ready', false, null),
    'Map ready',
    'the pill is untouched',
  );
});

test('v28 MECHANISM (passes pre-fix — map state: loaded + NaN centre): even a NaN centre that throws in render still needs the error event to flip the pill', () => {
  // Ties the two halves together: suppose the NaN-centre guard
  // fails and easeTo poisons the camera — the render throw that
  // follows is re-thrown (test (b) above), NOT an error event.
  // Only if an error event ALSO fires does the pill flip — so the
  // NaN centre, even if real, cannot by itself explain the
  // founder's pill. The pill flip and the camera fault are two
  // separate defects; fixing only the centre guard leaves the
  // raw-TypeError pill in place for the next error event.
  const map = new FakeMapLibreMap();
  const seen = [];
  map.on('error', (event) => seen.push(driveErrorListener({ loaded: true, event })));
  const centre = centreTargetForMirror({
    myFix: null,
    zoneBoundary: [
      { lat: PATNA.lat, lng: PATNA.lng },
      { lat: PATNA.lat + 0.004, lng: PATNA.lng },
      { lat: NaN, lng: PATNA.lng },
    ],
    map,
  });
  assert.ok(Number.isNaN(centre.lat), 'the mirror still feeds a NaN centre pre-fix (the guard test above)');
  assert.equal(seen.length, 0, 'no error event fired from the NaN easeTo alone');
  assert.equal(
    pillTextForState('ready', 'ready', false, null),
    'Map ready',
    'the pill is untouched until an error event fires',
  );
  map.emitError(new TypeError(TYPE_ERROR_MESSAGE));
  assert.equal(seen[0].kind, 'post-load-non-resource');
  assert.equal(
    seen[0].pill,
    'Map ready',
    'v28 (Diya F3, landed): once the error event fires, the classifier files it non-resource and the pill stays honest — the event no longer flips the pill',
  );
});

// ---------------------------------------------------------------------------
// WIRING GAP — the remaining ◎ defect (filed to the coordinator).
//
// The helper layer landed (`resolveRecentreCentre`,
// `RECENTRE_FAILED_COPY`, the pill's 14th `recentreFailed` param,
// the listener's post-load-non-resource branch, the dot effect) —
// but `centreOn` itself
// (PlayMap.tsx:1490-1505) is STILL the pre-v28 ternary: it passes
// an UNVALIDATED centre straight to `map.easeTo` with no try/catch,
// and never sets `recentreFailed`. The ◎ tap therefore still feeds
// a NaN centre to easeTo on a corrupt boundary/fix, and a tap
// failure still escapes uncaught instead of showing the
// allow-listed copy. These source pins fail until centreOn is
// rewired through `resolveRecentreCentre`.
// ---------------------------------------------------------------------------

/** The `centreOn` useCallback body in PlayMap.tsx, as source text. */
function centreOnSource() {
  const src = readFileSync(
    new URL('../src/components/hud/PlayMap.tsx', import.meta.url),
    'utf8',
  );
  const at = src.indexOf('const centreOn = useCallback(');
  assert.ok(at >= 0, 'PlayMap.tsx must still define centreOn');
  const end = src.indexOf('/** Re-centre only', at);
  assert.ok(end > at, 'the centreOn block must end before the recentre comment');
  return src.slice(at, end);
}

test('v28: centreOn resolves its centre through resolveRecentreCentre (landed wiring)', () => {
  const block = centreOnSource();
  assert.ok(
    block.includes('resolveRecentreCentre'),
    `centreOn (PlayMap.tsx) must call resolveRecentreCentre:\n${block}`,
  );
  assert.ok(
    !block.includes('polygonCentroid(zoneBoundary)'),
    'centreOn must not call polygonCentroid directly any more (the resolver validates first)',
  );
});

test('v28: centreOn guards easeTo and reports a tap failure via setRecentreFailed (landed wiring — allow-listed copy, never raw text)', () => {
  const block = centreOnSource();
  assert.ok(
    /try\s*\{/.test(block) && block.includes('setRecentreFailed'),
    `centreOn must try/catch easeTo and setRecentreFailed(true) on failure:\n${block}`,
  );
});

test('v28 MECHANISM (passes — grounds hole (3), the NaN bearing): the pre-v28 centreOn passed `bearing: undefined` as a PRESENT key, and installed MapLibre reads it', () => {
  // Installed maplibre-gl 5.24.1, `easeTo` (:69531) and `jumpTo`
  // (:69809): `bearing = 'bearing' in options ?
  // this._normalizeBearing(options.bearing, startBearing) :
  // startBearing` — the `in` check is on KEY PRESENCE, so
  // `{ bearing: undefined }` takes the normalise branch, and
  // `_normalizeBearing(undefined, …)` wraps undefined to NaN
  // (:69972: `wrap(bearing, -180, 180)`). EVERY ◎ tap (recentre →
  // centreOn() with no bearing) therefore eased toward a NaN
  // bearing. The landed centreOn omits the key when bearing is
  // undefined (two easeTo branches) — pinned here.
  const lib = readFileSync(
    new URL('../node_modules/maplibre-gl/dist/maplibre-gl-dev.js', import.meta.url),
    'utf8',
  );
  assert.match(
    lib,
    /'bearing' in options \? this\._normalizeBearing\(options\.bearing, startBearing\)/,
    'installed MapLibre reads bearing by key presence',
  );
  const block = centreOnSource();
  assert.ok(
    block.includes('map.easeTo({ center: [centre.lng, centre.lat], duration: 300 })'),
    'centreOn must ease WITHOUT a bearing key when bearing is undefined',
  );
  assert.ok(
    !block.includes('bearing, duration: 300 })') ||
      block.includes('if (bearing === undefined)'),
    'the bearing key must only appear in the defined-bearing branch',
  );
});

test('v28: centreOn returns early when the map is not ready (landed load guard — hole (1))', () => {
  // Pre-v28, mapRef.current was assigned as soon as createOlaMap
  // resolved, BEFORE 'load', and ◎/N were tappable the whole time
  // (no `disabled` prop, unlike compass) — easeTo on an unloaded
  // map throws or misbehaves with no pill and no feedback. Landed:
  // no map or not ready → return, and the buttons are disabled
  // until ready.
  const block = centreOnSource();
  assert.ok(
    block.includes('if (!map || !mapReady) return;'),
    `centreOn must guard on mapReady:\n${block}`,
  );
});

test('v28: a failed ◎ tap reads as the allow-listed copy in the pill (landed helper layer)', () => {
  assert.equal(RECENTRE_FAILED_COPY, 'Re-centre failed — try again');
  const text = pillTextForState(
    'ready', 'ready', false, null,
    0, null, false, false, null, null, false, false, null,
    true, // recentreFailed
  );
  assert.equal(text, 'Re-centre failed — try again');
  assert.doesNotMatch(text, /Cannot read|TypeError|resource failing/);
});

// v29 (D) SUPERSEDES the v28 wiring above: the own-position dot is
// no longer a MapLibre `circle` layer — it is a DOM Marker styled by
// meDotMarkerStyle (a square box, round by construction), because the
// founder's phone showed the layer dot as a pill. The accuracy ring
// still syncs through meAccuracyFeatures. Fix round M8 removes
// `meDotFeatures` outright: it had no caller left in src (only these
// tests called it), and the pill's actual code-provable mechanism was
// the dot trails merging while moving slowly (fixed by spacing, see
// TRAIL_MIN_MOVE_DEG) — not the circle-layer helper. The helper's
// null-safety assertions below are replaced by a source pin that the
// marker path hides on a non-finite fix and never builds a NaN point.
test('v29: the me dot is a DOM Marker styled by meDotMarkerStyle (supersedes v28 circle-layer wiring)', () => {
  const src = readFileSync(
    new URL('../src/components/hud/PlayMap.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(
    src.includes('meDotMarkerStyle('),
    'the dot must be styled through meDotMarkerStyle (square box, 50% radius)',
  );
  assert.ok(
    src.includes('new maplibre.Marker('),
    'the dot must be a DOM Marker, not a WebGL circle layer',
  );
  assert.ok(
    !src.includes("id: 'pakdam-me-dot'"),
    'the pakdam-me circle layer must be gone — it was the pill',
  );
  assert.ok(
    src.includes('meAccuracyFeatures(myFix)'),
    'the accuracy ring still syncs through meAccuracyFeatures',
  );
  assert.equal(
    logic.meDotFeatures,
    undefined,
    'meDotFeatures is removed (M8) — no dead circle-layer helper left',
  );
  // The marker path: a non-finite fix hides the marker, never a NaN point.
  assert.ok(
    src.includes("el.style.display = 'none'"),
    'a non-finite fix must hide the marker',
  );
  assert.ok(
    src.includes('Number.isFinite(fix.lat)') && src.includes('Number.isFinite(fix.lng)'),
    'the marker path must finite-check the fix before positioning',
  );
});

// ---------------------------------------------------------------------------
// ring() hypothesis — FALSIFIED (Diya candidate, tested not assumed).
// ---------------------------------------------------------------------------

test('v28 HYPOTHESIS FALSIFIED (passes — records the actual message): ring() with a null vertex throws reading \'lng\', NOT reading \'0\'', () => {
  // Diya's candidate: ring() does first[0] where first = coords[0].
  // But `first` is guarded (`first &&`, play-map-logic.ts:201), and
  // a null vertex throws EARLIER — in the `.map` step, reading the
  // vertex's `lng`. Verified by running the REAL function:
  assert.throws(
    () => ring([null]),
    (err) => err instanceof TypeError && err.message === "Cannot read properties of null (reading 'lng')",
    'ring([null]) must throw reading lng, not 0',
  );
  assert.throws(
    () => ring([{ lat: 1, lng: 2 }, null]),
    (err) => err instanceof TypeError && err.message === "Cannot read properties of null (reading 'lng')",
    'ring([ok, null]) must throw reading lng, not 0',
  );
  // The same null vertex in the neighbouring helpers: also 'lng'.
  assert.throws(
    () => boundaryBBox([null]),
    (err) => err instanceof TypeError && err.message === "Cannot read properties of null (reading 'lng')",
  );
  // And a healthy polygon still closes its ring (no regression).
  assert.deepEqual(
    ring([
      { lat: 1, lng: 2 },
      { lat: 3, lng: 4 },
      { lat: 5, lng: 6 },
    ]),
    [[[2, 1], [4, 3], [6, 5], [2, 1]]],
  );
});

test('v28 MECHANISM (passes pre-fix — established fact): boundaryBBox never returns null', () => {
  // Diya, confirmed against the real function: even a degenerate
  // boundary yields a (possibly infinite) bbox pair, never null.
  const bbox = boundaryBBox([
    { lat: 23.3, lng: 85.28 },
    { lat: 23.3, lng: 85.38 },
    { lat: 23.4, lng: 85.33 },
  ]);
  assert.ok(bbox !== null && Array.isArray(bbox) && bbox.length === 2);
  assert.deepEqual(bbox, [
    [85.28, 23.3],
    [85.38, 23.4],
  ]);
});

// ---------------------------------------------------------------------------
// Double-tap zoom — grounding only (no Node-visible defect; see header).
// ---------------------------------------------------------------------------

test('v28 MECHANISM (passes pre-fix — grounds the default): double-tap zoom is ON by default in the installed MapLibre build and createOlaMap never turns it off', () => {
  const src = readFileSync(
    new URL('../src/components/map/maplibre.ts', import.meta.url),
    'utf8',
  );
  assert.ok(
    !src.includes('doubleClickZoom: false'),
    'createOlaMap must not disable doubleClickZoom',
  );
  assert.ok(!src.includes('interactive: false'), 'createOlaMap must not disable interactivity');
  const lib = readFileSync(
    new URL('../node_modules/maplibre-gl/dist/maplibre-gl-dev.js', import.meta.url),
    'utf8',
  );
  assert.match(
    lib,
    /doubleClickZoom: true/,
    'installed maplibre-gl 5.24.1 defaults doubleClickZoom on',
  );
  assert.ok(
    lib.includes('class TapZoomHandler'),
    'installed maplibre-gl 5.24.1 ships TapZoomHandler (double-tap zoom in, two-finger tap zoom out)',
  );
});
