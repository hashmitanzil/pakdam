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
 * Two documented deviations from real MapLibre (Diya F9):
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
 */

export class FakeMapLibreMap {
  constructor(options = {}) {
    this.containerWidth = options.containerWidth ?? 660;
    this.containerHeight = options.containerHeight ?? 525;
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
