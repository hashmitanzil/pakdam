import test from 'node:test';
import assert from 'node:assert/strict';
import { addDrawPoint, canApplyDraw, drawPointsEqual, undoDrawPoint } from '../../components/host-setup/drawPoints.js';

// ---------------------------------------------------------------------------
// Draw zone — tap-to-place points (founder spec, 2026-11-19): no default
// hexagon; tap the map and a numbered point drops; 3 taps enclose the
// zone; Undo removes the last point; Redraw clears all; DONE applies.
// Pure helpers (components/host-setup/drawPoints.ts), pinned here
// without a constructed map — the Playwright specs cover the map UI.
// RUNNING: same scratch-compile flow as the other suites in this
// directory (see scripts/test-web-lib.sh header). This file IS in the
// script's file list (added 2026-11-19) so it runs with the suite.
// ---------------------------------------------------------------------------

test('addDrawPoint appends in tap order — point numbers are list positions', () => {
  const p0 = addDrawPoint([], 23.36, 85.33);
  assert.deepEqual(p0, [{ lat: 23.36, lng: 85.33 }]);
  const p3 = addDrawPoint(addDrawPoint(p0, 23.37, 85.34), 23.35, 85.32);
  assert.equal(p3.length, 3);
  assert.deepEqual(p3[2], { lat: 23.35, lng: 85.32 });
  // The input list is never mutated.
  assert.equal(p0.length, 1);
});

test('undoDrawPoint removes the LAST point only', () => {
  const pts = [
    { lat: 1, lng: 1 },
    { lat: 2, lng: 2 },
    { lat: 3, lng: 3 },
  ];
  assert.deepEqual(undoDrawPoint(pts), [
    { lat: 1, lng: 1 },
    { lat: 2, lng: 2 },
  ]);
  assert.equal(pts.length, 3, 'input is not mutated');
});

test('undoDrawPoint on an empty draft stays empty', () => {
  assert.deepEqual(undoDrawPoint([]), []);
});

test('canApplyDraw: 0–2 points cannot enclose a zone; 3+ can', () => {
  assert.equal(canApplyDraw([]), false);
  assert.equal(canApplyDraw([{ lat: 1, lng: 1 }]), false);
  assert.equal(
    canApplyDraw([
      { lat: 1, lng: 1 },
      { lat: 2, lng: 2 },
    ]),
    false,
  );
  assert.equal(
    canApplyDraw([
      { lat: 1, lng: 1 },
      { lat: 2, lng: 2 },
      { lat: 3, lng: 3 },
    ]),
    true,
  );
  assert.equal(
    canApplyDraw([
      { lat: 1, lng: 1 },
      { lat: 2, lng: 2 },
      { lat: 3, lng: 3 },
      { lat: 4, lng: 4 },
      { lat: 5, lng: 5 },
    ]),
    true,
  );
});

test('drawPointsEqual: same points in order are equal; anything else is not', () => {
  const a = [
    { lat: 1, lng: 1 },
    { lat: 2, lng: 2 },
  ];
  assert.equal(drawPointsEqual(a, [...a]), true);
  assert.equal(drawPointsEqual(a, a), true);
  assert.equal(drawPointsEqual(null, null), true);
  assert.equal(drawPointsEqual(a, null), false);
  assert.equal(drawPointsEqual(null, a), false);
  assert.equal(
    drawPointsEqual(a, [
      { lat: 1, lng: 1 },
      { lat: 2, lng: 3 },
    ]),
    false,
  );
  assert.equal(drawPointsEqual(a, [{ lat: 1, lng: 1 }]), false);
  assert.equal(
    drawPointsEqual(
      [
        { lat: 2, lng: 2 },
        { lat: 1, lng: 1 },
      ],
      a,
    ),
    false,
    'order matters — a reordered draft is not the applied shape',
  );
});
