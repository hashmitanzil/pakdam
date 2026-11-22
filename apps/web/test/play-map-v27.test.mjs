import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const logic = await import('../src/components/hud/play-map-logic.ts');
const { FakeMapLibreMap } = await import('./fake-map.mjs');
const { circlePolygon } = await import('@pakdam/engine');
const { diagnoseMapAreaHeight, pillTextForState } = logic;

/**
 * play-map-v27.test.mjs — the v27 play-map fix.
 *
 * ROOT CAUSE (Diya, 2026-11-21 — this is NOT a MapLibre sizing bug
 * and NOT a stale flag): a CSS cascade collision. The map container
 * is `<div ref={containerRef} className="absolute inset-0 h-full
 * w-full" />` (PlayMap.tsx:1660 — the `h-full w-full` IS the fix);
 * its height used to come ENTIRELY from `position: absolute` +
 * `inset-0` stretching it to the outer div. `new Map` runs
 * `container.classList.add('maplibregl-map')`, and the installed
 * stylesheet says `.maplibregl-map{...;overflow:hidden;position:
 * relative;...}`. Tailwind v4 emits `.absolute{position:absolute}`
 * inside `@layer utilities`, while the MapLibre sheet is UNLAYERED —
 * unlayered author styles beat layered ones at equal specificity
 * (both single-class 0,1,0) regardless of import order, verified in
 * the built CSS (`.next/static/css/7dfd643b849ac952.css` unlayered vs
 * `a444a52ecf07859d.css` `@layer utilities`). So computed `position`
 * on the container was `relative`, `inset-0` became harmless zero
 * offsets, and height fell back to content height — which is 0,
 * because `.maplibregl-canvas-container` has no positioning rule and
 * the canvas is `position:absolute` (out of flow). Container rect =
 * 526×0 persistently; outer stays 526×420. That is exactly the
 * founder's measurement, and Retry rebuilds re-add the class, so
 * rebuilds reproduced it. The setup map paints because
 * PlayAreaMap.tsx:652,684 puts inline `style={{height}}` on its
 * container — inline style beats every stylesheet rule. The fix:
 * `h-full w-full` (height is uncontested — the MapLibre sheet sets
 * no height — only `position` is), so the size no longer depends on
 * `position:absolute` at all.
 *
 * KILLED hypotheses (Diya — do NOT rebuild tests around these):
 *  - the CANVAS hypothesis: `_containerDimensions` falls back
 *    400×300 and `_resizeCanvas` sets explicit inline style px, so
 *    the canvas is 526×300 for the founder's 526×0 container, not 0.
 *    The fake models this (fake-map.mjs: containerDimensions +
 *    canvas style size); a 0-height canvas reading only occurs
 *    under `display:none` (all rects 0 → hidden-by-design).
 *  - the STALE-FLAG hypothesis: all set/clear sites traced, re-checks
 *    cover every layout event. The flag logic is already correct —
 *    no flag state machine is specified here beyond the flag→pill
 *    wiring (Section D).
 *
 * FIX REQUIREMENT (what these tests prove): the container needs a
 * height that does NOT depend on `position: absolute` winning —
 * verified in the BUILT CSS, not source, because layers decide
 * this. A fix that merely re-asserts `absolute` without `!important`
 * loses the same way. Also: (a) the RO size-return trigger stays
 * intact and a spent/escalated fit budget must not leave the map
 * permanently un-fitted after the geometry is repaired; (b) size is
 * re-checked after the awaits in `createOlaMap` — implemented as a
 * post-await `mapBuildDecision` check that DISCARDS a map built into
 * a flat area and defers via waitObserver (PlayMap.tsx:585–590);
 * (c) the v26 header comment's mental model is corrected (it
 * asserted the container tracks the outer via inset-0 — true only
 * while absolute wins); (d) pill precedence (zero-height first) and
 * all v25/v26 behaviour are kept. And the pill distinguishes
 * container-zero-height from canvas-zero-height in its text.
 *
 * WHAT THIS FILE PINS (v27):
 *  A. `diagnoseMapAreaHeight` — one test per diagnosis value, exact
 *     rects (the founder's 526.4×0 container case is now EXPLAINED
 *     by the cascade above, not a mystery sizing bug).
 *  B. The pill distinguishes container vs canvas — FULL exact text,
 *     not a substring — for height AND width. Overlaps Meera's own
 *     v27 pill test in play-map-logic.test.mjs deliberately: this
 *     file pins each case separately, including the default (null
 *     diagnosis → legacy generic texts) and hidden-by-design/ok.
 *  C. The geometry fix — the cascade mechanism in the BUILT CSS
 *     (pins WHY absolute loses), the container carrying a height
 *     that does not depend on absolute, the build/defer decision
 *     for Retry AND for post-await creation, and (a) the fit landing
 *     after geometry repair despite a spent/escalated budget.
 *  D. The zeroHeight flag reaches the pill. No flag state machine —
 *     the stale-flag hypothesis is dead.
 *  E. Post-resize verification through the fake — `canvasMatchesContainer`
 *     with its 1 px tolerance, and the repair ladder
 *     (`canvasRepairStep`): one re-resize first, then ONE bounded
 *     rebuild. The E3 case is the REAL v27 sequence (a
 *     container-geometry mismatch defers; the geometry fix + resize
 *     repairs it); E4 is the DEFENSIVE ladder for a genuinely stuck
 *     canvas, not the root cause.
 *
 * LANDED v27 API (play-map-logic.ts — the functions below are the
 * production code PlayMap.tsx imports):
 *  - `pillTextForState(..., heightDiagnosis = null)` — 13th trailing
 *    optional param, a `MapAreaHeightDiagnosis | null`. A defect
 *    diagnosis on a ready map is the WHOLE pill (D9 precedence);
 *    'ok' / 'hidden-by-design' fall through to the normal ready
 *    text; null keeps the legacy boolean behaviour (the generic
 *    "Map area has no height/width" texts — the component always
 *    passes its live diagnosis, so generics only survive for older
 *    callers).
 *  - `mapBuildDecision(diagnosis): 'build' | 'defer'` — 'build'
 *    when the container HAS size ('ok' / 'canvas-zero-height' /
 *    'canvas-zero-size': a canvas defect is repaired by recreating
 *    into the sized container); 'defer' when it does not
 *    ('hidden-by-design' / 'container-zero-height' /
 *    'container-zero-size': never build into a flat area). The
 *    single build gate for mount, Retry, and the post-await
 *    re-check.
 *  - `canvasMatchesContainer(canvasRect, containerRect, tolerancePx
 *    = 1): boolean` — per-dimension |diff| <= tolerance. The 1 px
 *    default is load-bearing: canvas style px are integers
 *    (clientWidth) while a getBoundingClientRect container width can
 *    be fractional (526 vs 526.4) on a healthy map.
 *  - `canvasRepairStep(resizesTried: number): 're-resize' |
 *    'recreate'` — 0 → 're-resize' (one more resize may repair it),
 *    >= 1 → 'recreate' (a resize already failed to repair it).
 *
 * PILL STRINGS (LANDED — read from play-map-logic.ts; full-text
 * assertions throughout Section B):
 *
 * Tests are labelled like play-map-logic.test.mjs:
 *  - MECHANISM (passes pre-fix — pins why the break happens).
 *  - REPRODUCTION (fails pre-fix — passes after the fix): the test
 *    asserts the FIXED behaviour and FAILS against the pre-fix code.
 *
 * NOT testable under Node (needs a browser / React — the founder's
 * live-phone check is the verdict for these):
 *  - the ACTUAL computed style (a real layout engine applying the
 *    cascade to the live DOM); the built-CSS tests below verify the
 *    cascade inputs, not the computed result.
 *  - the React wiring: retryMap → retryNonce → creation effect,
 *    the waitObserver, the ResizeObserver callbacks, the double-rAF
 *    tab-return path, the createOlaMap awaits, and `verifyCanvasPainted`
 *    itself (a useCallback) — the Node tests drive its exact steps
 *    through the fake via the production functions it calls.
 *  - the mapDetail strings in PlayMap.tsx
 *    (ZERO_HEIGHT_CONTAINER_DETAIL / ZERO_HEIGHT_CANVAS_DETAIL /
 *    ZERO_WIDTH_DETAIL) — component-level, not exported.
 *  - a real-device getBoundingClientRect under display:none.
 */

// The founder's live game: Classic, 500 m zone, Patna — and the
// founder's exact live measurement: a 526.4 px wide × 0 high rect.
const PATNA = { lat: 25.5941, lng: 85.1376 };
const FOUNDER_WIDTH = 526.4;
const REAL_BOUNDARY = circlePolygon(PATNA, 500, 64);

// --- Landed v27 pill strings (read from play-map-logic.ts) ---
const PILL_CONTAINER_ZERO_HEIGHT = 'Map container has no height — try Retry';
const PILL_CANVAS_ZERO_HEIGHT = 'Map canvas has no height — try Retry';
const PILL_CONTAINER_ZERO_WIDTH = 'Map container has no width — try Retry';
const PILL_CANVAS_ZERO_WIDTH = 'Map canvas has no width — try Retry';

/**
 * The pill for one diagnosis, via the landed 13th `heightDiagnosis`
 * param. The zeroHeight / zeroWidth booleans are passed consistently
 * with the diagnosis, as the component (which holds both the flags
 * and the live diagnosis) does.
 */
function pillForDiagnosis(diagnosis, overrides = {}) {
  const {
    mapState = 'ready',
    mapDetail = 'ready',
    slowLoad = false,
    elapsedS = null,
    tileErrorCount = 0,
    tileDetail = null,
    fitFailed = false,
    zeroHeight =
      diagnosis === 'container-zero-height' || diagnosis === 'canvas-zero-height',
    otherResource = null,
    fitReason = null,
    fitPending = false,
    zeroWidth =
      diagnosis === 'container-zero-size' || diagnosis === 'canvas-zero-size',
  } = overrides;
  return pillTextForState(
    mapState,
    mapDetail,
    slowLoad,
    elapsedS,
    tileErrorCount,
    tileDetail,
    fitFailed,
    zeroHeight,
    otherResource,
    fitReason,
    fitPending,
    zeroWidth,
    diagnosis, // v27: 13th param, the live MapAreaHeightDiagnosis (or null).
  );
}

/**
 * Drives a build (Retry or creation) through the fake map using the
 * PRODUCTION decision (`mapBuildDecision`). Returns { built, map,
 * decision }.
 */
function simulateBuild({ diagnosis, containerRect, oldMap = null }) {
  const decision = logic.mapBuildDecision(diagnosis);
  assert.ok(
    decision === 'build' || decision === 'defer',
    `mapBuildDecision must return 'build' | 'defer', got ${JSON.stringify(decision)}`,
  );
  if (decision === 'defer') return { built: false, map: null, decision };
  if (oldMap) oldMap.remove();
  const map = new FakeMapLibreMap({
    containerWidth: containerRect.width,
    containerHeight: containerRect.height,
  });
  return { built: true, map, decision };
}

// ---------------------------------------------------------------------------
// Built CSS (Section C): the cascade is decided by the BUILD output,
// not source — so these tests read .next/static/css/*.css (content-
// hashed names: glob, never hardcode). They SKIP (not fail) when no
// production build output exists in this tree.
// ---------------------------------------------------------------------------

const BUILT_CSS_DIR = new URL('../.next/static/css/', import.meta.url);
let builtCssFiles = [];
try {
  if (existsSync(BUILT_CSS_DIR)) {
    builtCssFiles = readdirSync(BUILT_CSS_DIR).filter((f) => f.endsWith('.css'));
  }
} catch {
  builtCssFiles = [];
}
const BUILT_CSS_AVAILABLE = builtCssFiles.length > 0;
const BUILT_CSS_SKIP = BUILT_CSS_AVAILABLE
  ? false
  : 'no built CSS in .next/static/css — run a production build first (layers decide this, not source)';

function readBuiltCssSheets() {
  return builtCssFiles.map((f) => readFileSync(new URL(f, BUILT_CSS_DIR), 'utf8'));
}

/** The PlayMap container element's source text (from `ref={containerRef}` to its `/>`). */
function playMapContainerElement() {
  const src = readFileSync(
    new URL('../src/components/hud/PlayMap.tsx', import.meta.url),
    'utf8',
  );
  const at = src.indexOf('ref={containerRef}');
  assert.ok(at >= 0, 'PlayMap.tsx must still have the containerRef div');
  const end = src.indexOf('/>', at);
  assert.ok(end > at, 'the container div must be self-closing');
  return src.slice(at, end);
}

// ---------------------------------------------------------------------------
// A. diagnoseMapAreaHeight — one test per diagnosis value, exact rects.
// ---------------------------------------------------------------------------

test('v27: diagnoseMapAreaHeight — ok: outer, container and canvas all have real size', () => {
  assert.equal(
    diagnoseMapAreaHeight(
      { width: FOUNDER_WIDTH, height: 420 },
      { width: FOUNDER_WIDTH, height: 400 },
      { width: FOUNDER_WIDTH, height: 400 },
    ),
    'ok',
  );
  // No canvas yet (pre-load) is not a height failure either.
  assert.equal(
    diagnoseMapAreaHeight(
      { width: FOUNDER_WIDTH, height: 420 },
      { width: FOUNDER_WIDTH, height: 400 },
      null,
    ),
    'ok',
  );
});

test('v27: diagnoseMapAreaHeight — hidden-by-design: the wrapper is display:none, so the outer slot is 0-height', () => {
  // Radio / More tab: the whole slot is hidden — 0-height BY DESIGN.
  assert.equal(
    diagnoseMapAreaHeight(
      { width: FOUNDER_WIDTH, height: 0 },
      { width: FOUNDER_WIDTH, height: 0 },
      null,
    ),
    'hidden-by-design',
  );
  // display:none zeroes EVERY rect — even a canvas that would have
  // size reads 0. Still hidden-by-design, never a defect.
  assert.equal(
    diagnoseMapAreaHeight(
      { width: 0, height: 0 },
      { width: 0, height: 0 },
      { width: 0, height: 0 },
    ),
    'hidden-by-design',
  );
});

test('v27: diagnoseMapAreaHeight — container-zero-height: THE FOUNDER’S EXACT CASE (outer 526.4×420, container 526.4×0)', () => {
  // Root cause (Diya): the CSS cascade makes the container's computed
  // position `relative`, so inset-0 cannot stretch it — the outer
  // stays 526.4×420 while the container collapses to 526.4×0.
  assert.equal(
    diagnoseMapAreaHeight(
      { width: FOUNDER_WIDTH, height: 420 },
      { width: FOUNDER_WIDTH, height: 0 },
      null,
    ),
    'container-zero-height',
  );
  // The canvas does NOT read 0 here: the real fallback canvas is
  // 526×300 (width real, height the 300 fallback) — and the diagnosis
  // is still container-zero-height, because the container is checked
  // BEFORE the canvas.
  assert.equal(
    diagnoseMapAreaHeight(
      { width: FOUNDER_WIDTH, height: 420 },
      { width: FOUNDER_WIDTH, height: 0 },
      { width: 526, height: 300 },
    ),
    'container-zero-height',
  );
});

test('v27: diagnoseMapAreaHeight — canvas-zero-height: container has height, the canvas inside it does not', () => {
  assert.equal(
    diagnoseMapAreaHeight(
      { width: FOUNDER_WIDTH, height: 420 },
      { width: FOUNDER_WIDTH, height: 400 },
      { width: FOUNDER_WIDTH, height: 0 },
    ),
    'canvas-zero-height',
  );
});

test('v27: diagnoseMapAreaHeight — container-zero-size: container has height but its width is 0 on the visible tab', () => {
  assert.equal(
    diagnoseMapAreaHeight(
      { width: FOUNDER_WIDTH, height: 420 },
      { width: 0, height: 420 },
      null,
    ),
    'container-zero-size',
  );
});

test('v27: diagnoseMapAreaHeight — canvas-zero-size: container has size, the canvas inside it has no width', () => {
  assert.equal(
    diagnoseMapAreaHeight(
      { width: FOUNDER_WIDTH, height: 420 },
      { width: FOUNDER_WIDTH, height: 400 },
      { width: 0, height: 400 },
    ),
    'canvas-zero-size',
  );
});

test('v27: diagnoseMapAreaHeight — height outranks width: a 0×0 container is a height defect, not a size defect', () => {
  assert.equal(
    diagnoseMapAreaHeight(
      { width: FOUNDER_WIDTH, height: 420 },
      { width: 0, height: 0 },
      null,
    ),
    'container-zero-height',
  );
  assert.equal(
    diagnoseMapAreaHeight(
      { width: FOUNDER_WIDTH, height: 420 },
      { width: FOUNDER_WIDTH, height: 400 },
      { width: 0, height: 0 },
    ),
    'canvas-zero-height',
  );
});

test('v27: diagnoseMapAreaHeight — container outranks canvas: both at 0 height names the container', () => {
  assert.equal(
    diagnoseMapAreaHeight(
      { width: FOUNDER_WIDTH, height: 420 },
      { width: FOUNDER_WIDTH, height: 0 },
      { width: FOUNDER_WIDTH, height: 0 },
    ),
    'container-zero-height',
  );
  assert.equal(
    diagnoseMapAreaHeight(
      { width: FOUNDER_WIDTH, height: 420 },
      { width: 0, height: 420 },
      { width: 0, height: 420 },
    ),
    'container-zero-size',
  );
});

test('v27: diagnoseMapAreaHeight — negative sizes are treated as zero (defensive: getBoundingClientRect never returns them)', () => {
  assert.equal(
    diagnoseMapAreaHeight(
      { width: FOUNDER_WIDTH, height: 420 },
      { width: FOUNDER_WIDTH, height: -1 },
      null,
    ),
    'container-zero-height',
  );
  assert.equal(
    diagnoseMapAreaHeight(
      { width: FOUNDER_WIDTH, height: 420 },
      { width: -1, height: 420 },
      null,
    ),
    'container-zero-size',
  );
});

// ---------------------------------------------------------------------------
// B. The pill distinguishes container-zero from canvas-zero — FULL exact
// text, not a substring, for height AND width.
// ---------------------------------------------------------------------------

test('v27 REPRODUCTION (fails pre-fix — passes after the fix): the pill names a CONTAINER with no height', () => {
  assert.equal(pillForDiagnosis('container-zero-height'), PILL_CONTAINER_ZERO_HEIGHT);
});

test('v27 REPRODUCTION (fails pre-fix — passes after the fix): the pill names a CANVAS with no height', () => {
  assert.equal(pillForDiagnosis('canvas-zero-height'), PILL_CANVAS_ZERO_HEIGHT);
});

test('v27 REPRODUCTION (fails pre-fix — passes after the fix): the pill names a CONTAINER with no width', () => {
  assert.equal(pillForDiagnosis('container-zero-size'), PILL_CONTAINER_ZERO_WIDTH);
});

test('v27 REPRODUCTION (fails pre-fix — passes after the fix): the pill names a CANVAS with no width', () => {
  assert.equal(pillForDiagnosis('canvas-zero-size'), PILL_CANVAS_ZERO_WIDTH);
});

test('v27 REPRODUCTION (fails pre-fix — passes after the fix): zero-height outranks tile errors — the pill names the height defect only', () => {
  // D9 precedence (zero-height first) survives the container/canvas
  // split: the height text is the WHOLE pill, no tile part appended.
  assert.equal(
    pillForDiagnosis('container-zero-height', {
      tileErrorCount: 2,
      tileDetail: 'HTTP 401 — tile failed',
    }),
    PILL_CONTAINER_ZERO_HEIGHT,
  );
  assert.equal(
    pillForDiagnosis('canvas-zero-height', {
      tileErrorCount: 2,
      tileDetail: 'HTTP 401 — tile failed',
    }),
    PILL_CANVAS_ZERO_HEIGHT,
  );
});

test('v27 REPRODUCTION (fails pre-fix — passes after the fix): zero-height outranks a failed fit — the pill names the height defect only', () => {
  assert.equal(
    pillForDiagnosis('container-zero-height', {
      fitFailed: true,
      fitReason: 'camera could not fit the zone',
    }),
    PILL_CONTAINER_ZERO_HEIGHT,
  );
  assert.equal(
    pillForDiagnosis('canvas-zero-height', {
      fitFailed: true,
      fitReason: 'camera could not fit the zone',
    }),
    PILL_CANVAS_ZERO_HEIGHT,
  );
});

test('v27: hidden-by-design and ok never produce a defect pill', () => {
  assert.equal(pillForDiagnosis('hidden-by-design'), 'Map ready');
  assert.equal(pillForDiagnosis('ok'), 'Map ready');
});

test('v27: with no diagnosis passed, the legacy generic texts still apply (backward-compat of the new param)', () => {
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, true, null, null, false, false, null),
    'Map area has no height — try Retry',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, false, null, null, false, true, null),
    'Map area has no width — try Retry',
  );
});

// ---------------------------------------------------------------------------
// C. The geometry fix — the CSS cascade, the container height, the
// build/defer decision, and the fit budget after geometry repair.
// ---------------------------------------------------------------------------

test('v27 MECHANISM (passes pre-fix — pins why `absolute` loses): in the BUILT CSS the MapLibre sheet is UNLAYERED with position:relative, while Tailwind `.absolute` sits inside `@layer utilities`', { skip: BUILT_CSS_SKIP }, () => {
  const sheets = readBuiltCssSheets();
  const maplibreSheet = sheets.find((css) => css.includes('.maplibregl-map{'));
  assert.ok(maplibreSheet, 'a built sheet must contain the .maplibregl-map rule');
  assert.ok(
    !maplibreSheet.includes('@layer'),
    'the MapLibre sheet must be UNLAYERED (no @layer anywhere in it) — unlayered beats layered at equal specificity regardless of import order',
  );
  assert.match(
    maplibreSheet,
    /\.maplibregl-map\{[^}]*position:relative/,
    'the unlayered .maplibregl-map rule must set position:relative',
  );
  // The canvas is position:absolute — out of flow — so a relative
  // container's height falls back to content height, which is 0.
  assert.match(
    maplibreSheet,
    /\.maplibregl-canvas\{[^}]*position:absolute/,
    'the .maplibregl-canvas rule must set position:absolute (out of flow)',
  );
  const tailwindSheet = sheets.find((css) => css.includes('@layer utilities'));
  assert.ok(tailwindSheet, 'a built sheet must contain @layer utilities');
  const layerAt = tailwindSheet.indexOf('@layer utilities');
  const absoluteAt = tailwindSheet.search(/\.absolute\{[^}]*position:absolute/);
  assert.ok(absoluteAt > layerAt, '.absolute must sit INSIDE @layer utilities (after it opens)');
});

test('v27 MECHANISM (passes pre-fix — pins the fix shape): `.maplibregl-map` sets NO height, so a height utility is uncontested — and `.h-full` is emitted in the built CSS', { skip: BUILT_CSS_SKIP }, () => {
  const sheets = readBuiltCssSheets();
  const maplibreSheet = sheets.find((css) => css.includes('.maplibregl-map{'));
  assert.ok(maplibreSheet, 'a built sheet must contain the .maplibregl-map rule');
  const rule = maplibreSheet.match(/\.maplibregl-map\{[^}]*\}/);
  assert.ok(rule, 'the .maplibregl-map rule must exist');
  assert.ok(
    !/height\s*:/.test(rule[0]),
    `.maplibregl-map must set no height (so h-full is uncontested) — got: ${rule[0]}`,
  );
  assert.ok(
    sheets.some((css) => /\.h-full\{[^}]*height:100%/.test(css)),
    '.h-full{height:100%} must be emitted in the built CSS',
  );
});

test('v27 REPRODUCTION (fails pre-fix — passes after the fix): the play-map container height must NOT depend on `position: absolute` winning — h-full/w-full or an inline style height', () => {
  // A fix that merely re-asserts `absolute` without `!important`
  // loses the same way (see the MECHANISM test above). The container
  // must carry a height that is uncontested: `h-full` (height:100%
  // — the MapLibre sheet sets no height) or an inline style height
  // as PlayAreaMap does. The built CSS cannot attribute a utility to
  // a specific div, so this is a source pin — the live-phone check
  // is the final verdict on the computed style.
  const el = playMapContainerElement();
  const hasFullHeight = /\bh-full\b/.test(el);
  const hasInlineHeight = /style=\{\{[^}]*height/.test(el);
  assert.ok(
    hasFullHeight || hasInlineHeight,
    `container must carry h-full or an inline style height — got: ${el.trim()}`,
  );
});

test('v27 REPRODUCTION (fails pre-fix — passes after the fix): mapBuildDecision — build into a sized container, defer into a flat one', () => {
  const { mapBuildDecision } = logic;
  // The container HAS size: build. A canvas defect is repaired by
  // recreating into the sized container.
  assert.equal(mapBuildDecision('ok'), 'build');
  assert.equal(mapBuildDecision('canvas-zero-height'), 'build');
  assert.equal(mapBuildDecision('canvas-zero-size'), 'build');
  // The container has NO size: defer — never build into a flat area.
  // A rebuild into a 0-height container just re-adds
  // `maplibregl-map` and reproduces the 526×0 collapse.
  assert.equal(mapBuildDecision('hidden-by-design'), 'defer');
  assert.equal(mapBuildDecision('container-zero-height'), 'defer');
  assert.equal(mapBuildDecision('container-zero-size'), 'defer');
});

test('v27 REPRODUCTION (fails pre-fix — passes after the fix): Retry into a sized container rebuilds — the new canvas has real height', () => {
  const oldMap = new FakeMapLibreMap({ containerWidth: 526, containerHeight: 420 });
  oldMap.setCanvasSize(526, 0); // the old map's canvas is 0-height (defect state)
  const { built, map, decision } = simulateBuild({
    diagnosis: 'canvas-zero-height',
    containerRect: { width: 526, height: 420 },
    oldMap,
  });
  assert.equal(decision, 'build');
  assert.equal(built, true);
  assert.equal(oldMap.removed, true, 'the old map is removed before the rebuild');
  assert.deepEqual(map.canvasRect(), { width: 526, height: 420 });
  assert.ok(map.canvasRect().height > 0, 'the rebuilt canvas has real height');
});

test('v27 REPRODUCTION (fails pre-fix — passes after the fix): Retry while the container is still 0 does NOT rebuild — it defers, and re-measures after the container gains size', () => {
  let diagnosis = diagnoseMapAreaHeight(
    { width: FOUNDER_WIDTH, height: 420 },
    { width: FOUNDER_WIDTH, height: 0 },
    null,
  );
  assert.equal(diagnosis, 'container-zero-height');
  const first = simulateBuild({
    diagnosis,
    containerRect: { width: 526, height: 0 },
  });
  assert.equal(first.decision, 'defer');
  assert.equal(first.built, false);
  assert.equal(first.map, null, 'no map is constructed into the flat area');
  // The container gains size (the CSS fix lands / the tab returns);
  // the next measurement re-decides, and the rebuild proceeds.
  diagnosis = diagnoseMapAreaHeight(
    { width: FOUNDER_WIDTH, height: 420 },
    { width: FOUNDER_WIDTH, height: 420 },
    null,
  );
  assert.equal(diagnosis, 'ok');
  const second = simulateBuild({
    diagnosis,
    containerRect: { width: 526, height: 420 },
  });
  assert.equal(second.decision, 'build');
  assert.equal(second.built, true);
  assert.deepEqual(second.map.canvasRect(), { width: 526, height: 420 });
});

test('v27 REPRODUCTION (fails pre-fix — passes after the fix): creation re-checks size AFTER the awaits in createOlaMap — a tab switch mid-creation defers construction (Diya AT RISK-1 / (b))', async () => {
  // Creation starts while the container is sized…
  let containerRect = { width: 526, height: 420 };
  let diagnosis = diagnoseMapAreaHeight(
    { width: FOUNDER_WIDTH, height: 420 },
    containerRect,
    null,
  );
  assert.equal(diagnosis, 'ok');
  // …then the player switches tab DURING the createOlaMap awaits
  // (dynamic import + style load). The await resolves:
  await Promise.resolve();
  // …to a 0-height container. The post-await re-check must defer,
  // not construct a map into the flat area. (The production
  // re-check is PlayMap.tsx:585–590: it measures the LIVE diagnosis
  // and runs `mapBuildDecision` on it — discarding a map built into
  // a flat area and deferring via waitObserver. This test drives the
  // same decision through the fake; the React wiring itself is
  // verified by reading + live phone.)
  containerRect = { width: 526, height: 0 };
  diagnosis = diagnoseMapAreaHeight(
    { width: FOUNDER_WIDTH, height: 420 },
    containerRect,
    null,
  );
  assert.equal(diagnosis, 'container-zero-height');
  const deferred = simulateBuild({ diagnosis, containerRect });
  assert.equal(deferred.decision, 'defer');
  assert.equal(deferred.built, false);
  assert.equal(deferred.map, null);
  // Tab back: the container has size again — construction proceeds.
  containerRect = { width: 526, height: 420 };
  diagnosis = diagnoseMapAreaHeight(
    { width: FOUNDER_WIDTH, height: 420 },
    containerRect,
    null,
  );
  const built = simulateBuild({ diagnosis, containerRect });
  assert.equal(built.decision, 'build');
  assert.equal(built.built, true);
  assert.deepEqual(built.map.canvasRect(), { width: 526, height: 420 });
});

test('v27 (a): a spent/escalated fit budget must NOT leave the map permanently un-fitted after the geometry is repaired — the size-return re-attempt lands', () => {
  const {
    createFitRetryBudget,
    scheduleFitRetryTimer,
    fitOutcomeAction,
    fitEscalationReason,
    tryFitZone,
  } = logic;
  const map = new FakeMapLibreMap({ containerWidth: 0, containerHeight: 0 });
  const fittedRef = { current: false };
  const budget = createFitRetryBudget();
  // A synchronous scheduler: the timer fires at once, so the budget
  // burns without waiting 2 s per retry.
  const syncSchedule = (fn) => {
    fn();
    return 0;
  };
  let escalatedReason = null;
  // The container is 0 while the fit keeps deferring: 3 timer
  // retries fire, the 4th finds the budget spent and escalates.
  for (let attempt = 0; attempt < 4; attempt++) {
    const outcome = tryFitZone(fittedRef, map, REAL_BOUNDARY, false);
    assert.equal(outcome, 'hidden', `attempt ${attempt + 1}: a 0-size container defers the fit`);
    const action = fitOutcomeAction(outcome);
    assert.equal(action.action, 'retry');
    const timer = scheduleFitRetryTimer(budget, action.outcome, () => {}, syncSchedule);
    if (timer === null) escalatedReason = fitEscalationReason(action.outcome);
  }
  assert.equal(budget.deferredFired, 3, 'all 3 deferred retries fired');
  assert.ok(
    escalatedReason !== null && escalatedReason.includes('3 attempts'),
    `escalation reason recorded: ${escalatedReason}`,
  );
  assert.equal(fittedRef.current, false, 'the fit never landed while the container was 0');
  // GEOMETRY REPAIRED (the CSS fix): the container gains height.
  // The ResizeObserver size-return (prevHasSize false→true) re-runs
  // the fit effect — the attempt runs DIRECTLY, the spent budget only
  // gates the TIMER, so it must land now instead of staying escalated.
  map.containerWidth = 526;
  map.containerHeight = 420;
  map.resize();
  assert.deepEqual(map.canvasRect(), { width: 526, height: 420 });
  const outcome = tryFitZone(fittedRef, map, REAL_BOUNDARY, true);
  assert.equal(outcome, 'fitted');
  assert.equal(
    fitOutcomeAction(outcome).action,
    'landed',
    'a landed fit clears the escalated reason',
  );
  assert.equal(fittedRef.current, true);
  const cam = map.camera();
  assert.ok(
    Math.abs(cam.centre[0] - PATNA.lng) < 0.001 &&
      Math.abs(cam.centre[1] - PATNA.lat) < 0.001,
    `camera is at the Patna zone, not the Ranchi default (got ${cam.centre})`,
  );
  assert.ok(cam.zoom >= 13 && cam.zoom <= 17, `zoom ${cam.zoom} is street-level`);
});

// ---------------------------------------------------------------------------
// Fake-map canvas grounding (v27): the fake's canvas model is faithful
// to installed maplibre-gl 5.24.1 — construction + resize() set the
// canvas style size from _containerDimensions() (400×300 fallback),
// resize() has no early return on matching sizes. These pin the fake;
// the canvas was never 0 (Diya killed that hypothesis).
// ---------------------------------------------------------------------------

test('v27: fake grounding — construction in a sized container gives the canvas the container size', () => {
  const map = new FakeMapLibreMap({ containerWidth: 526, containerHeight: 420 });
  assert.deepEqual(map.canvasRect(), { width: 526, height: 420 });
  assert.deepEqual(map.containerRect(), { width: 526, height: 420 });
});

test('v27: fake grounding — construction in a 0-size container gives a 400×300 canvas (the real _containerDimensions fallback), NOT a 0 canvas', () => {
  const map = new FakeMapLibreMap({ containerWidth: 0, containerHeight: 0 });
  assert.deepEqual(map.containerRect(), { width: 0, height: 0 });
  assert.deepEqual(map.canvasRect(), { width: 400, height: 300 });
});

test('v27: fake grounding — the fallback is per-dimension: a 526×0 container gives a 526×300 canvas (the founder’s exact numbers)', () => {
  const map = new FakeMapLibreMap({ containerWidth: 526, containerHeight: 0 });
  assert.deepEqual(map.canvasRect(), { width: 526, height: 300 });
  const map2 = new FakeMapLibreMap({ containerWidth: 0, containerHeight: 420 });
  assert.deepEqual(map2.canvasRect(), { width: 400, height: 420 });
});

test('v27: fake grounding — resize() has no early return on matching sizes, and only resize() (not assignment) updates the canvas', () => {
  const map = new FakeMapLibreMap({ containerWidth: 0, containerHeight: 0 });
  assert.deepEqual(map.canvasRect(), { width: 400, height: 300 });
  map.resize();
  map.resize();
  assert.equal(map.resizeCount, 2, 'two resize() calls at the same size both run');
  assert.deepEqual(map.canvasRect(), { width: 400, height: 300 });
  // The container gains size (a DOM layout change) — the canvas does
  // NOT follow until resize() re-reads the container.
  map.containerWidth = 526;
  map.containerHeight = 420;
  assert.deepEqual(map.canvasRect(), { width: 400, height: 300 });
  map.resize();
  assert.equal(map.resizeCount, 3);
  assert.deepEqual(map.canvasRect(), { width: 526, height: 420 });
});

test('v27: fake grounding — resize() at a still-0 container sets the canvas to the 400×300 fallback, never to 0', () => {
  const map = new FakeMapLibreMap({ containerWidth: 526, containerHeight: 420 });
  assert.deepEqual(map.canvasRect(), { width: 526, height: 420 });
  map.containerWidth = 0;
  map.containerHeight = 0;
  map.resize();
  assert.deepEqual(map.canvasRect(), { width: 400, height: 300 });
  assert.ok(map.canvasRect().height > 0, 'no resize() can produce a 0-height canvas');
});

// ---------------------------------------------------------------------------
// D. The zeroHeight flag reaches the pill. No flag state machine is
// specified here: Diya KILLED the stale-flag hypothesis (all set/clear
// sites traced, re-checks cover every layout event) — the flag logic
// in checkMapAreaHeight is already correct and needs no extraction.
// ---------------------------------------------------------------------------

test('v27: the zeroHeight flag reaches the pill — and a cleared flag restores "Map ready"', () => {
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, true, null, null, false, false),
    'Map area has no height — try Retry',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, false, null, null, false, false),
    'Map ready',
  );
});

// ---------------------------------------------------------------------------
// E. Post-resize verification through the fake — `canvasMatchesContainer`
// (1 px tolerance) and the repair ladder (`canvasRepairStep`): one
// re-resize first, then ONE bounded rebuild. The production verify is
// PlayMap.tsx `verifyCanvasPainted` (match check → ladder with a
// recursive re-verify → one rebuild from the load handler only);
// these tests drive its exact steps through the fake with the
// production functions it calls.
// ---------------------------------------------------------------------------

test('v27 REPRODUCTION (fails pre-fix — passes after the fix): canvasMatchesContainer — a 1 px tolerance absorbs the fractional container rect, a real mismatch does not', () => {
  const { canvasMatchesContainer } = logic;
  // Canvas style px are integers (clientWidth); a healthy container
  // rect can be fractional (526 vs 526.4) — that MUST match.
  assert.equal(
    canvasMatchesContainer({ width: 526, height: 420 }, { width: 526.4, height: 420 }),
    true,
  );
  // …and the tolerance is load-bearing: at tolerance 0 it does not.
  assert.equal(
    canvasMatchesContainer({ width: 526, height: 420 }, { width: 526.4, height: 420 }, 0),
    false,
  );
  assert.equal(
    canvasMatchesContainer({ width: 526, height: 420 }, { width: 526, height: 420 }),
    true,
  );
  // Inside the tolerance on both axes.
  assert.equal(
    canvasMatchesContainer({ width: 525.5, height: 420 }, { width: 526.4, height: 420 }),
    true,
  );
  // Outside it (1.4 px in width).
  assert.equal(
    canvasMatchesContainer({ width: 525, height: 420 }, { width: 526.4, height: 420 }),
    false,
  );
  // A real mismatch: the fallback canvas against a real container,
  // and a 0-height canvas against a real container.
  assert.equal(
    canvasMatchesContainer({ width: 400, height: 300 }, { width: 526.4, height: 420 }),
    false,
  );
  assert.equal(
    canvasMatchesContainer({ width: 526, height: 0 }, { width: 526, height: 420 }),
    false,
  );
});

test('v27 REPRODUCTION (fails pre-fix — passes after the fix): canvasRepairStep — one re-resize first, recreate once a resize has already failed to repair it', () => {
  const { canvasRepairStep } = logic;
  assert.equal(canvasRepairStep(0), 're-resize');
  assert.equal(canvasRepairStep(1), 'recreate');
  assert.equal(canvasRepairStep(2), 'recreate');
});

test('v27 REPRODUCTION (fails pre-fix — passes after the fix): the REAL v27 sequence — a container-geometry mismatch defers (no resize loop, no rebuild); the geometry fix + resize repairs it', () => {
  const { canvasMatchesContainer, mapBuildDecision } = logic;
  // The CSS-bug state, after a resize: the container is 526×0 and
  // the canvas is the 526×300 fallback — NOT 0. resize() cannot fix
  // a 0 container; it just re-applies the fallback.
  const map = new FakeMapLibreMap({ containerWidth: 526, containerHeight: 0 });
  assert.deepEqual(map.canvasRect(), { width: 526, height: 300 });
  map.resize();
  assert.deepEqual(map.canvasRect(), { width: 526, height: 300 });
  assert.equal(
    canvasMatchesContainer(map.canvasRect(), map.containerRect()),
    false,
    'canvas 526×300 vs container 526×0 is a mismatch',
  );
  const diagnosis = diagnoseMapAreaHeight(
    { width: FOUNDER_WIDTH, height: 420 },
    { width: FOUNDER_WIDTH, height: 0 },
    { width: 526, height: 300 },
  );
  assert.equal(diagnosis, 'container-zero-height');
  // The repair here is NOT "re-resize" or "recreate" — both would
  // reproduce the collapse. It is DEFER until the geometry is fixed.
  assert.equal(mapBuildDecision(diagnosis), 'defer');
  // GEOMETRY REPAIRED (the CSS fix): the container gains height;
  // resize() then repairs the canvas and the verification passes.
  map.containerHeight = 420;
  map.resize();
  assert.deepEqual(map.canvasRect(), { width: 526, height: 420 });
  assert.equal(
    canvasMatchesContainer(map.canvasRect(), map.containerRect()),
    true,
  );
});

test('v27 REPRODUCTION (fails pre-fix — passes after the fix): the DEFENSIVE ladder — a genuinely stuck canvas gets one re-resize, then a recreate', () => {
  const { canvasMatchesContainer, canvasRepairStep, mapBuildDecision } = logic;
  // Fault injection only (the real canvas was never 0 — Diya): a
  // canvas stuck at 0 height while its container is real.
  const map = new FakeMapLibreMap({ containerWidth: 526, containerHeight: 420 });
  map.setCanvasSize(526, 0);
  map.freezeCanvas();
  assert.equal(
    diagnoseMapAreaHeight(
      { width: FOUNDER_WIDTH, height: 420 },
      { width: FOUNDER_WIDTH, height: 420 },
      { width: 526, height: 0 },
    ),
    'canvas-zero-height',
  );
  assert.equal(
    canvasMatchesContainer(map.canvasRect(), map.containerRect()),
    false,
  );
  // The container HAS size, so the repair is a rebuild (not a defer).
  assert.equal(mapBuildDecision('canvas-zero-height'), 'build');
  assert.equal(canvasRepairStep(0), 're-resize');
  map.resize();
  assert.equal(
    canvasMatchesContainer(map.canvasRect(), map.containerRect()),
    false,
    'the frozen canvas survives the re-resize',
  );
  assert.equal(canvasRepairStep(1), 'recreate');
  map.remove();
  const rebuilt = new FakeMapLibreMap({ containerWidth: 526, containerHeight: 420 });
  assert.deepEqual(rebuilt.canvasRect(), { width: 526, height: 420 });
  assert.equal(
    canvasMatchesContainer(rebuilt.canvasRect(), rebuilt.containerRect()),
    true,
  );
});
