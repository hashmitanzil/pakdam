/**
 * v30 GPS-watch tests (Meera) — what `watchLocation` surfaces.
 *
 * v29 and earlier swallowed timeouts: a phone whose GPS chip searched
 * 15 s with no fix (indoors, cold start) produced NOTHING from the
 * error path — no notice, no retry — and the play page dropped the
 * 'unsupported' kind entirely. v30 surfaces timeouts (the watch stays
 * alive; it is a notice, never a suspension or a dot clear) and the
 * play page handles timeout + unsupported with play-appropriate copy
 * and a "Try again" (source-pinned in v30-gps-dot.test.mjs).
 *
 * The navigator fake follows v28-fix-round-2.test.mjs: Node 24
 * exposes `navigator` as a getter-only global property, so the
 * descriptor is swapped and restored. A real GeolocationPositionError
 * carries its constants on the instance (error.TIMEOUT === 3), so
 * the fakes do too.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('./resolve-hooks.mjs', import.meta.url);

const { watchLocation } = await import('../src/lib/geolocation.ts');

async function withNavigator(fake, fn) {
  const prevDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: fake,
    configurable: true,
    writable: true,
  });
  try {
    await fn();
  } finally {
    if (prevDesc) Object.defineProperty(globalThis, 'navigator', prevDesc);
    else delete globalThis.navigator;
  }
}

const ERR_CONSTS = { PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };

function errorWith(code) {
  return { code, ...ERR_CONSTS };
}

function position({ lat = 23.35, lng = 85.33, accuracy = 8, timestampMs = Date.now() } = {}) {
  return {
    coords: { latitude: lat, longitude: lng, accuracy },
    timestamp: timestampMs,
  };
}

test('timeout (v30): a 15 s search with no fix is SURFACED, not swallowed', async () => {
  const seen = [];
  let cleared = null;
  await withNavigator(
    {
      geolocation: {
        watchPosition: (_ok, onError) => {
          onError(errorWith(3));
          return 7;
        },
        clearWatch: (id) => {
          cleared = id;
        },
      },
    },
    async () => {
      const handle = watchLocation(
        () => seen.push('fix'),
        (err) => seen.push(err),
      );
      assert.equal(seen.length, 1, 'the timeout must reach onError');
      assert.equal(seen[0].kind, 'timeout');
      // The watch stays alive after a timeout (the OS keeps trying):
      // a handle must still be returned so the caller can stop it.
      assert.ok(handle, 'a handle must be returned even after a timeout error');
      handle?.stop();
      assert.equal(cleared, 7, 'stop() clears the watch id');
    },
  );
});

test('unsupported (v30): no geolocation API calls onError with kind unsupported and returns null', async () => {
  const seen = [];
  await withNavigator(
    {},
    async () => {
      const handle = watchLocation(
        () => seen.push('fix'),
        (err) => seen.push(err),
      );
      assert.equal(handle, null, 'no watch can be created without the API');
      assert.equal(seen.length, 1);
      assert.equal(seen[0].kind, 'unsupported');
      assert.match(seen[0].message, /no GPS/);
    },
  );
});

test('permission-denied + position-unavailable messages are unchanged (v28 pins)', async () => {
  const seen = [];
  await withNavigator(
    {
      geolocation: {
        watchPosition: (_ok, onError) => {
          onError(errorWith(1));
          return 7;
        },
        clearWatch: () => {},
      },
    },
    async () => {
      watchLocation(
        () => {},
        (err) => seen.push(err),
      );
    },
  );
  assert.equal(seen[0].kind, 'permission-denied');
  assert.equal(
    seen[0].message,
    'Location is off — allow it in your browser settings, then tap the map to place the zone.',
  );

  const seen2 = [];
  await withNavigator(
    {
      geolocation: {
        watchPosition: (_ok, onError) => {
          onError(errorWith(2));
          return 7;
        },
        clearWatch: () => {},
      },
    },
    async () => {
      watchLocation(
        () => {},
        (err) => seen2.push(err),
      );
    },
  );
  assert.equal(seen2[0].kind, 'position-unavailable');
  assert.equal(seen2[0].message, 'GPS is unavailable right now — tap the map to place the zone.');
});

test('a valid fix is delivered; an exact-timestamp duplicate is deduped', async () => {
  const fixes = [];
  const now = Date.now();
  await withNavigator(
    {
      geolocation: {
        watchPosition: (onOk) => {
          onOk(position({ timestampMs: now }));
          onOk(position({ timestampMs: now }));
          onOk(position({ timestampMs: now + 1000, lng: 85.331 }));
          return 7;
        },
        clearWatch: () => {},
      },
    },
    async () => {
      const handle = watchLocation((fix) => fixes.push(fix));
      assert.equal(fixes.length, 2, 'duplicate timestamp delivers once; the new fix delivers');
      assert.equal(fixes[0].accuracyMeters, 8);
      assert.equal(fixes[1].lng, 85.331);
      handle?.stop();
    },
  );
});

test('a fix worse than ±1000 m never reaches onFix (validateFix rejects it)', async () => {
  const fixes = [];
  const now = Date.now();
  await withNavigator(
    {
      geolocation: {
        watchPosition: (onOk) => {
          onOk(position({ accuracy: 1500, timestampMs: now }));
          onOk(position({ accuracy: 900, timestampMs: now + 1000 }));
          return 7;
        },
        clearWatch: () => {},
      },
    },
    async () => {
      const handle = watchLocation((fix) => fixes.push(fix));
      assert.equal(fixes.length, 1, 'only the 900 m fix is delivered');
      assert.equal(fixes[0].accuracyMeters, 900);
      handle?.stop();
    },
  );
});

test('dedupe (v30): a REJECTED fix must not poison the timestamp dedupe for a valid same-ms fix', async () => {
  const fixes = [];
  const now = Date.now();
  await withNavigator(
    {
      geolocation: {
        watchPosition: (onOk) => {
          // Same millisecond, different accuracy: the 1500 m fix is
          // rejected — the old code stamped lastTimestampMs before
          // validation, so this valid fix was dropped as a "duplicate".
          onOk(position({ accuracy: 1500, timestampMs: now }));
          onOk(position({ accuracy: 900, timestampMs: now }));
          return 7;
        },
        clearWatch: () => {},
      },
    },
    async () => {
      const handle = watchLocation((fix) => fixes.push(fix));
      assert.equal(fixes.length, 1, 'the valid same-ms fix must still be delivered');
      assert.equal(fixes[0].accuracyMeters, 900);
      handle?.stop();
    },
  );
});

test('stop() clears the watch id returned by watchPosition', async () => {
  let cleared = null;
  await withNavigator(
    {
      geolocation: {
        watchPosition: () => 42,
        clearWatch: (id) => {
          cleared = id;
        },
      },
    },
    async () => {
      const handle = watchLocation(() => {});
      assert.ok(handle);
      handle.stop();
      assert.equal(cleared, 42);
    },
  );
});
