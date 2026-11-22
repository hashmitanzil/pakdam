/**
 * fake-map.mjs — a fake `MapLibreMapLike` for the v25 play-map tests.
 *
 * Implements the repo's `MapLibreMapLike` interface
 * (`apps/web/src/components/map/maplibre.ts`) in plain Node: it records
 * every call, models a real camera (fitBounds/flyTo/easeTo move the
 * centre + zoom), emits `load`/`error` on demand, and can be made to
 * throw — so the play-map logic can be tested without a browser.
 *
 * STRICT model, on purpose: real MapLibre rejects calls on a removed
 * map, and a NaN camera is a broken camera. So:
 *  - `fitBounds` with any non-finite bound THROWS (a NaN camera never
 *    paints the zone; the test must see the failure, not a silent NaN).
 *  - `fitBounds` when the viewport cannot fit the bounds is a SILENT
 *    NO-OP, exactly like real MapLibre: `cameraForBounds` returns
 *    undefined (warn only, no throw) when the transform is smaller
 *    than the padding, and `fitBounds` then returns without moving
 *    the camera. The fake models this via `cameraForBounds` (undefined
 *    when containerWidth/Height minus padding < 0 — strict, like the
 *    installed maplibre-gl 5.24.1 `cameraForBoxAndBearing`, which
 *    returns undefined only for scaleX/scaleY < 0) so a test can
 *    prove `tryFitZone` does NOT consume the one fit on a stale
 *    zero-size transform (v26). The container size on the fake is
 *    fixed at construction — a test "resizes" it by assigning
 *    `map.containerWidth` / `map.containerHeight` directly.
 *  - At EXACTLY zero available size (an 80 px container with 40 px
 *    padding — v26 fix round, Diya 4), real `cameraForBounds` does
 *    NOT return undefined: it returns a camera with zoom −∞
 *    (`scaleZoom(0) = log2(0)`), and `fitBounds` flies the camera
 *    there. The fake models that too (`cameraForBounds` returns the
 *    −∞ camera, `fitBounds` applies it), so a test can prove the
 *    production guard (`cameraCanFitBounds`) rejects it BEFORE any
 *    `fitBounds` call.
 *  - `getSource` / a source's `setData` THROW after `remove()` (a rAF
 *    frame landing after removal must be caught by the production code,
 *    not by the fake being lenient).
 *  - `resize()` after `remove()` THROWS (real MapLibre `resize()` runs
 *    `_resizeInternal` on the destroyed painter — `remove()` calls
 *    `painter.destroy()` — so it is NOT a proven no-op; the tab-return
 *    handler must not depend on it being safe).
 *  - `triggerRepaint()` after `remove()` is a lenient no-op (real
 *    MapLibre guards it with `if (this.style ...)` and `remove()` calls
 *    `setStyle(null)`, so it never runs on a removed map).
 * `failFitBoundsTimes(n)` injects transient `fitBounds` failures (the
 * first-fit-throws reproduction). Zoom is derived from the fitted span
 * so a correct 500 m fit lands at a street-level zoom, not the default.
 *
 * v27 CANVAS MODEL (Arjun — grounded in installed maplibre-gl 5.24.1,
 * `node_modules/maplibre-gl/dist/maplibre-gl-dev.js`):
 *  - `resize()` (:71682) has NO early return on matching sizes: it
 *    always runs `_resizeInternal` (:71712) → `_resizeCanvas` +
 *    `painter.resize` + `_resizeTransform`. The fake records and
 *    counts every `resize()` call and always re-applies the canvas
 *    size — it never had an early return, and the v27 tests pin that.
 *  - `_containerDimensions()` (:73658) falls back to 400×300 when
 *    `clientWidth`/`clientHeight` are 0 (`clientWidth || 400`,
 *    `clientHeight || 300`, each dimension independently). The fake
 *    models this in `containerDimensions()`; the canvas style size is
 *    set from it at construction (like `_setupCanvas` :73727-73729)
 *    and on every `resize()` (like `_resizeInternal` :71713-71715).
 *  - `_resizeCanvas()` (:73737) sets EXPLICIT canvas style width/
 *    height px (`canvas.style.width = `${width}px``). The fake's
 *    `canvasWidth`/`canvasHeight` are that style size — what
 *    `getBoundingClientRect()` reports for the canvas when rendered.
 *    Assigning `containerWidth`/`containerHeight` alone does NOT
 *    resize the canvas (that models a DOM layout change); only
 *    `resize()` (or construction) re-reads the container.
 *  - CORRECTION to the v27 working hypothesis ("a map created at 0
 *    size keeps a 0-height canvas unless resize repairs it"): the
 *    real build does NOT do that. A map built in a 0-size container
 *    gets a 400×300 canvas (the fallback), clipped invisible by the
 *    0 container — and `resize()` at a 0-size container sets the
 *    canvas to 400×300 too, never to 0. A `getBoundingClientRect`
 *    canvas height of 0 is therefore only readable when the canvas
 *    is under a `display:none` ancestor (then outer/container/canvas
 *    ALL read 0 — the 'hidden-by-design' case), never from
 *    construction/resize alone. On a VISIBLE tab with a collapsed
 *    container, container-zero and canvas-zero do NOT "read the
 *    same": the container reads 526.4×0 and the canvas reads 400×300.
 *    The diagnosis order (container before canvas) is what separates
 *    them — and the repair for a 0 container is to WAIT for size
 *    (defer), not to resize harder. For the founder's exact rect
 *    (container 526 wide × 0 tall) the canvas is 526×300 — width
 *    real, height the 300 fallback — confirmed by Diya in the live
 *    build, so the pill's container-vs-canvas distinction is a real
 *    one on a visible tab. `setCanvasSize` / `freezeCanvas`
 *    are test-only fault injection for the stuck-canvas repair
 *    ladder (see below), not real MapLibre behaviour.
 *
 * Documented deviations from real MapLibre:
 *  - STRICTER on `setData` after `remove()`: real MapLibre's `setData`
 *    itself never throws synchronously — the throw comes from
 *    `getSource` on a removed map. The fake throws from `setData` too,
 *    so a test that only exercises `setData` proves less than it
 *    looks; the production guard (`safeSetSourceData`) wraps the
 *    `getSource` call, which is where the real throw lives.
 *  - `fitBounds` after `remove()` still moves the fake camera: real
 *    MapLibre's camera path early-outs once the style is gone. The
 *    fake does not model that; no test asserts camera state on a
 *    removed map.
 *  - `resize()` does NOT change `containerWidth`/`containerHeight`:
 *    real MapLibre re-reads the container size on resize, but the
 *    fake has no DOM — a test assigns the dimensions directly to
 *    model a container gaining size. (Arjun advisory 4: this
 *    deviation is documented here, not hidden. It means the fake
 *    cannot model "real-size container, stale zero-size transform";
 *    the production mitigation — an explicit synchronous `map.resize()`
 *    before the fit, verified against installed maplibre-gl 5.24.1:
 *    `Map.resize` → `_resizeInternal` → `_resizeTransform` →
 *    `transform.resize`, all synchronous, unthrottled — stays
 *    React-only and is verified by code reading, not by this fake.)
 *  - The canvas model is the STYLE size only: the fake does not model
 *    `display:none` clipping, so a canvas under a hidden wrapper
 *    still reports its style size here (400×300 at a 0 container).
 *    Tests that need a 0 canvas rect pass explicit rects to
 *    `diagnoseMapAreaHeight` (or use `setCanvasSize` fault
 *    injection). `setCanvasSize` / `freezeCanvas` are test-only fault
 *    injection (v27): the real `_resizeCanvas` never writes a 0
 *    style size, so a canvas that "never gains size" is a defect
 *    the fake must be told to model, not something it models by
 *    default.
 */

export class FakeMapLibreMap {
  constructor(options = {}) {
    this.containerWidth = options.containerWidth ?? 660;
    this.containerHeight = options.containerHeight ?? 525;
    // The canvas style size (what getBoundingClientRect reports when
    // rendered) — set from _containerDimensions() at construction,
    // exactly like real MapLibre's _setupCanvas → _resizeCanvas
    // (maplibre-gl-dev.js :73727-73729). A 0-size container yields the
    // 400×300 fallback, NOT a 0 canvas (v27 grounding — see header).
    const [canvasWidth, canvasHeight] = this.containerDimensions();
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
    /** Test-only fault injection (v27): when true, resize() never updates the canvas. */
    this.canvasFrozen = false;
    this.centre = [...(options.centre ?? [85.33, 23.36])]; // [lng, lat] — Ranchi default
    this.zoom = options.zoom ?? 14;
    this.bearing = 0;
    this.removed = false;
    this.calls = []; // { method, ...args } in order
    this.sources = new Map(); // id -> { data, setDataCount }
    this.layers = new Set();
    this.handlers = new Map(); // event -> Set<handler>
    this.resizeCount = 0;
    this.repaintCount = 0;
    this.fitBoundsCount = 0;
    this.failFitBoundsRemaining = 0;
  }

  record(method, extra = {}) {
    this.calls.push({ method, ...extra });
  }

  callsOf(method) {
    return this.calls.filter((c) => c.method === method);
  }

  /** Next `n` fitBounds calls throw instead of moving the camera. */
  failFitBoundsTimes(n) {
    this.failFitBoundsRemaining = n;
  }

  camera() {
    return { centre: [...this.centre], zoom: this.zoom, bearing: this.bearing };
  }

  resize() {
    this.record('resize');
    this.resizeCount += 1;
    if (this.removed) {
      // Real MapLibre resize() after remove() runs _resizeInternal on
      // the destroyed painter — not a proven no-op. The tab-return
      // handler must catch this (Diya F6); the fake proves it does.
      throw new Error('FakeMap resize: map is removed (destroyed painter)');
    }
    // Real resize() (:71682) has NO early return on matching sizes:
    // it always runs _resizeInternal → _resizeCanvas from the CURRENT
    // container dimensions (with the 400×300 fallback). Assigning
    // containerWidth/containerHeight alone does NOT resize the canvas
    // — only resize() (or construction) does. A frozen canvas (test
    // fault injection) never updates.
    if (!this.canvasFrozen) {
      const [width, height] = this.containerDimensions();
      this.canvasWidth = width;
      this.canvasHeight = height;
    }
  }

  /**
   * The container dimensions MapLibre reads — `clientWidth ||
   * 400`, `clientHeight || 300` (installed maplibre-gl 5.24.1,
   * `_containerDimensions`, maplibre-gl-dev.js :73658). Each
   * dimension falls back independently.
   */
  containerDimensions() {
    return [this.containerWidth || 400, this.containerHeight || 300];
  }

  /** The canvas style size in px — what getBoundingClientRect reports when rendered. */
  canvasRect() {
    return { width: this.canvasWidth, height: this.canvasHeight };
  }

  /** The container rect, as the pill measures it. */
  containerRect() {
    return { width: this.containerWidth, height: this.containerHeight };
  }

  /**
   * Test-only fault injection (v27): set the canvas style size
   * directly — models the founder's symptom (a real-size container
   * with a 0-height canvas) so the post-resize repair ladder can be
   * tested. NOT a real MapLibre behaviour: the real _resizeCanvas
   * never writes 0 (see header).
   */
  setCanvasSize(width, height) {
    this.canvasWidth = width;
    this.canvasHeight = height;
  }

  /**
   * Test-only fault injection (v27): freeze the canvas so resize()
   * never updates it — models a canvas that never gains size. The
   * resize() call itself still records and counts (it ran; it just
   * did not repair the canvas).
   */
  freezeCanvas() {
    this.canvasFrozen = true;
  }

  triggerRepaint() {
    this.record('triggerRepaint');
    this.repaintCount += 1;
    // Real MapLibre guards triggerRepaint with `if (this.style ...)`
    // and remove() sets the style to null — a no-op after remove(),
    // not a throw. The handler still guards it (a repaint can throw
    // for other reasons — see the ThrowingRepaintMap tests).
  }

  remove() {
    this.record('remove');
    this.removed = true;
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(handler);
  }

  off(event, handler) {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(payload);
  }

  emitLoad() {
    this.emit('load', {});
  }

  emitError(error) {
    this.emit('error', { error });
  }

  getCenter() {
    return { lng: this.centre[0], lat: this.centre[1] };
  }

  getZoom() {
    return this.zoom;
  }

  getBearing() {
    return this.bearing;
  }

  flyTo(options) {
    this.record('flyTo', { options });
    if (options.center) this.centre = [...options.center];
    if (options.zoom !== undefined) this.zoom = options.zoom;
  }

  easeTo(options) {
    this.record('easeTo', { options });
    if (options.center) this.centre = [...options.center];
    if (options.zoom !== undefined) this.zoom = options.zoom;
    if (options.bearing !== undefined) this.bearing = options.bearing;
  }

  /**
   * The camera that would fit the bounds at the CURRENT viewport size,
   * or undefined when the viewport cannot fit them — the real
   * MapLibre `cameraForBounds` returns undefined (warn only) when the
   * available size after padding is < 0, i.e. the transform is
   * smaller than the padding (a stale zero-size transform). The
   * caller must check this before trusting a fitBounds call.
   *
   * v26 fix round (Diya 4): strict `< 0`, like the installed
   * maplibre-gl 5.24.1 — at EXACTLY 0 available size (an 80 px
   * container with 40 px padding) the real code returns a camera
   * with zoom −∞ (`scaleZoom(0) = log2(0)`), NOT undefined, and
   * `fitBounds` flies there. The fake returns that −∞ camera here
   * so the production guard (`cameraCanFitBounds`) is tested.
   */
  cameraForBounds(bounds, options = {}) {
    const [[minLng, minLat], [maxLng, maxLat]] = bounds;
    const padding = typeof options.padding === 'number' ? options.padding : 0;
    const availableWidth = this.containerWidth - padding * 2;
    const availableHeight = this.containerHeight - padding * 2;
    if (availableWidth < 0 || availableHeight < 0) return undefined;
    const centre = { lng: (minLng + maxLng) / 2, lat: (minLat + maxLat) / 2 };
    if (availableWidth === 0 || availableHeight === 0) {
      return { center: centre, zoom: -Infinity, bearing: 0 };
    }
    const spanLng = Math.max(maxLng - minLng, 1e-9);
    const zoom = Math.min(19, Math.max(3, 14 - Math.log2(spanLng / 0.01)));
    return {
      center: centre,
      zoom,
      bearing: 0,
    };
  }

  fitBounds(bounds, options = {}) {
    this.record('fitBounds', { bounds, options });
    this.fitBoundsCount += 1;
    const [[minLng, minLat], [maxLng, maxLat]] = bounds;
    const finite = [minLng, minLat, maxLng, maxLat].every(Number.isFinite);
    if (!finite) {
      throw new Error(
        `FakeMap fitBounds: non-finite bounds ${JSON.stringify(bounds)} — the camera would be NaN and paint nothing`,
      );
    }
    if (this.failFitBoundsRemaining > 0) {
      this.failFitBoundsRemaining -= 1;
      throw new Error('FakeMap fitBounds: injected failure (first fit throws)');
    }
    // Real MapLibre: cameraForBounds returns undefined when the
    // viewport cannot fit the bounds, and fitBounds then silently does
    // NOTHING (no throw, no camera move). A caller that marks the fit
    // consumed on any non-throwing return has lost its one fit.
    // At exactly-0 available size the camera is DEFINED with zoom −∞
    // and real fitBounds APPLIES it (flyTo with zoom −∞) — the fake
    // applies it too, so a test can prove the production guard never
    // lets a fitBounds call happen there.
    const camera = this.cameraForBounds(bounds, options);
    if (camera === undefined) {
      return;
    }
    this.centre = [camera.center.lng, camera.center.lat];
    this.zoom = camera.zoom;
  }

  addSource(id, spec) {
    this.record('addSource', { id });
    if (this.removed) throw new Error('FakeMap addSource: map is removed');
    const entry = {
      data: spec.data,
      setDataCount: 0,
      setData: (data) => {
        if (this.removed) {
          throw new Error('FakeMap setData: map is removed');
        }
        entry.data = data;
        entry.setDataCount += 1;
      },
    };
    this.sources.set(id, entry);
  }

  getSource(id) {
    if (this.removed) throw new Error('FakeMap getSource: map is removed');
    return this.sources.get(id);
  }

  addLayer(layer) {
    this.record('addLayer', { id: layer.id });
    if (this.removed) throw new Error('FakeMap addLayer: map is removed');
    this.layers.add(layer.id);
  }

  getLayer(id) {
    if (this.removed) return undefined;
    return this.layers.has(id) ? { id } : undefined;
  }

  removeLayer(id) {
    this.record('removeLayer', { id });
    this.layers.delete(id);
  }

  removeSource(id) {
    this.record('removeSource', { id });
    this.sources.delete(id);
  }
}
