import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

// ---------------------------------------------------------------------------
// Fakes — installed BEFORE importing the modules under test, so the
// socket's `typeof document` / `window.sessionStorage` / `WebSocket`
// / `fetch` lookups resolve to these, not to Node's (absent) globals.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeDocument() {
  const listeners = new Map();
  return {
    hidden: false,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
  };
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null;
    this.onerror = null;
    this.onclose = null;
    this.onmessage = null;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  /** Open the socket (the server accepted the handshake). */
  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  /**
   * Close from this side. A real browser fires onclose as a TASK, so
   * the close is queued with setTimeout(0) — a rejection already
   * queued as a microtask (e.g. the connect timeout) runs first,
   * exactly like production.
   */
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code: 1006 }), 0);
  }

  /** Drop the socket with a close event, synchronously. */
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const { SESSION_STORAGE_KEY } = await import('@pakdam/shared');

const doc = makeDocument();
globalThis.document = doc;
globalThis.WebSocket = FakeWebSocket;
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    ok: true,
    ticket: 'TKT',
    ticketId: 'TID',
    expiresAtMs: Date.now() + 60_000,
  }),
});
globalThis.window = {
  sessionStorage: {
    getItem: (key) =>
      key === SESSION_STORAGE_KEY
        ? JSON.stringify([
            {
              roomId: 'ROOM1',
              playerId: 'P1',
              mode: 'live',
              reconnectToken: 'RT',
              hostToken: '',
            },
          ])
        : null,
    setItem: () => {},
    removeItem: () => {},
  },
};
process.env.NEXT_PUBLIC_WORKER_URL = 'https://worker.test';

const logic = await import('../src/components/hud/play-map-logic.ts');
const {
  effectiveNowMs,
  GPS_DENIED_NOTICE,
  shouldWatchLocation,
  recentreFailedStale,
  isMapResourceError,
  classifyMapError,
} = logic;
const { watchLocation } = await import('../src/lib/geolocation.ts');
const store = await import('../src/lib/demo-store.ts');
const { createRoom, recordPlayerSuspension } = store;
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');
const { PakdamSocket } = await import('../src/lib/websocket.ts');

/**
 * v28-fix-round-2.test.mjs — the v28 final re-review fixes (Meera).
 *
 * 1. Diya R2 — a play page mounted while the tab is ALREADY hidden
 *    must seed its hidden-since stamp at mount, or the first tick
 *    after return ejects on the (4a) 30 s clock.
 * 2. Diya R3 + Zara V2 — a GPS-denied watch is never recreated on a
 *    same-tab re-enable; the play page gets an explicit "Try again"
 *    retry that re-runs the watcher effect.
 * 3. Zara V1 — `recentreFailed` never decayed on its own.
 * 4. Zara V3 — `recordPlayerSuspension`'s reason was an untyped
 *    string, interpolated into a player-visible announcement.
 * 5. Zara V4 — `isMapResourceError` matched bare "load"/"style"/
 *    "fetch", misfiling plain JS errors as resource failures.
 * 6. Diya A1 — `toError` mapped POSITION_UNAVAILABLE to a roughness
 *    message ("GPS is too rough here…").
 * 7. Diya A2 — `resyncAfterVisible` could stack duplicate snapshot
 *    retry chains.
 * 8. Diya A5 + A6 — two stale comments / notes (5 s clock, unusable
 *    zone).
 * 9. Diya A3 — `openSocket` had no connect timeout; a
 *    CONNECTING-forever socket never retried.
 *
 * Items 1–2 are component wiring (no jsdom harness in this repo):
 * the pure helpers are tested directly and the wiring is pinned by
 * source assertions, following the precedent in
 * v28-repro-fixstop.test.mjs. Items 7 and 9 drive the real
 * `PakdamSocket` with the fakes above.
 */

// createRoom validates the config: the default has an empty zone
// boundary, so the test room gets a 3-point triangle (Ranchi).
const TEST_CONFIG = {
  ...DEFAULT_ROOM_CONFIG,
  hostOnSiteConfirmed: true,
  zone: {
    boundary: [
      { lat: 23.3441, lng: 85.3096 },
      { lat: 23.3441, lng: 85.3196 },
      { lat: 23.3541, lng: 85.3146 },
    ],
    shrinkPhases: [],
  },
};

const T0 = 1_780_000_000_000;

// ---------------------------------------------------------------------------
// 1. Diya R2 — mount-hidden play page must not eject on return.
// ---------------------------------------------------------------------------

test('R2: effectiveNow excludes hidden time since mount (the (4a) clock)', () => {
  // Mount hidden at T0, match already ACTIVE, last fix at T0.
  // 40 s pass hidden; the player returns at T0+40 s.
  const hiddenGapTotalMs = 40_000;
  const effectiveNow = effectiveNowMs(T0 + 40_000, hiddenGapTotalMs);
  assert.equal(effectiveNow, T0, 'the hidden 40 s must not count toward the 30 s clock');
  assert.ok(
    effectiveNow - T0 < 30_000,
    'the first tick after return must NOT eject (effective age 0 s, not 40 s)',
  );
  // And without the gap (the pre-fix shape: hiddenSince never seeded,
  // gap 0) the same return WOULD eject — the seed is what saves it.
  assert.ok(
    effectiveNowMs(T0 + 40_000, 0) - T0 >= 30_000,
    'the pre-fix shape (gap 0) ejects at once — the mount seed is load-bearing',
  );
});

test('R2 (wiring pin): the play page seeds hiddenSinceRef at mount when document.hidden', () => {
  const src = readFileSync(
    new URL('../src/app/room/[roomId]/play/page.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(
    src.includes('if (document.hidden && hiddenSinceRef.current === null)'),
    'the watcher effect must seed hiddenSinceRef at mount when the tab is already hidden (Diya R2)',
  );
  assert.ok(
    src.includes('hiddenSinceRef.current = Date.now();'),
    'the mount seed must stamp the mount time',
  );
  // The (4a) check must run on the helper, not an inline subtraction
  // (so this test's arithmetic is the production arithmetic).
  assert.ok(
    src.includes('effectiveNowMs(now, hiddenGapTotalMsRef.current)'),
    'the (4a) check must compute effectiveNow through effectiveNowMs',
  );
});

// ---------------------------------------------------------------------------
// 2. Diya R3 + Zara V2 — GPS-denied retry.
// ---------------------------------------------------------------------------

test('R3: the denied notice is a shared constant the retry keys off', () => {
  assert.equal(
    GPS_DENIED_NOTICE,
    'Location is off — allow it in your browser settings.',
  );
});

test('R3: a manual retry is allowed to start a watch mid-game (visible tab, live phase)', () => {
  // The retry re-runs the watcher effect; the gate must let it start
  // a watch — a denial must not leave the page in a state where no
  // retry can ever watch again.
  assert.equal(shouldWatchLocation('ACTIVE', false), true);
  assert.equal(shouldWatchLocation('HEAD_START', false), true);
  assert.equal(shouldWatchLocation('SAFETY_PAUSED', false), true);
});

test('R3 (wiring pin): the play page offers "Try again" only for a GPS denial, and the tap re-runs the watcher effect', () => {
  const src = readFileSync(
    new URL('../src/app/room/[roomId]/play/page.tsx', import.meta.url),
    'utf8',
  );
  // The button renders only when the watch is dead on denial…
  assert.ok(
    src.includes('{gpsDenied ? ('),
    'the retry button must render only in the gps-denied state',
  );
  assert.ok(
    src.includes('Try again'),
    'the retry affordance must be labelled "Try again"',
  );
  // …and the tap bumps a nonce that is a dep of the watcher effect,
  // whose cleanup stops the dead watch first (startWatch refuses
  // while a handle is held — a bare re-call would be a no-op).
  assert.ok(
    src.includes('setGpsRetryNonce((n) => n + 1)'),
    'the tap must bump the retry nonce',
  );
  assert.ok(
    src.includes('[roomId, myPlayerId, mode, phase, gpsRetryNonce]'),
    'the watcher effect must re-run on the retry nonce',
  );
  // A fresh fix clears the denied state however the watch came back.
  assert.ok(
    src.includes('setGpsDenied(false);'),
    'a fix must clear the denied state (seat resumes on fix)',
  );
  // The old misleading comment is gone: the visibility resume is
  // NOT the only recreation path any more.
  assert.ok(
    !src.includes('the visibility resume below recreates it'),
    'the stale comment claiming the visibility resume recreates the watch must be gone',
  );
});

// ---------------------------------------------------------------------------
// 3. Zara V1 — recentreFailed decays on the same quiet clock.
// ---------------------------------------------------------------------------

test('V1: a failed ◎ tap decays after the 30 s quiet window, like otherResource', () => {
  const now = Date.now();
  assert.equal(recentreFailedStale(now - 5_000, now), false, 'fresh failure still shows');
  assert.equal(recentreFailedStale(now - 29_000, now), false, '29 s is not yet quiet');
  assert.equal(recentreFailedStale(now - 31_000, now), true, '31 s quiet clears it');
  assert.equal(recentreFailedStale(null, now), true, 'unstamped never sticks forever');
  assert.equal(recentreFailedStale(undefined, now), true);
});

test('V1 (wiring pin): PlayMap stamps the failure and clears it in the decay effect', () => {
  const src = readFileSync(
    new URL('../src/components/hud/PlayMap.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(
    src.includes('setRecentreFailedAtMs(Date.now())'),
    'the ◎ catch must stamp the failure time',
  );
  assert.ok(
    src.includes('recentreFailedStale(failedAtSchedule, Date.now())'),
    'the decay effect must clear recentreFailed on its own clock',
  );
  assert.ok(
    src.includes('[tileLedger, otherResource, recentreFailed, recentreFailedAtMs]'),
    'the decay effect must re-run when the failure state changes',
  );
});

// ---------------------------------------------------------------------------
// 4. Zara V3 — typed suspension reason.
// ---------------------------------------------------------------------------

test('V3: a gps-denied suspension suspends WITHOUT a host grace (like live)', () => {
  const demo = createRoom('Teo', TEST_CONFIG);
  const hostId = demo.players[0].playerId;
  assert.equal(demo.players[0].isHost, true);
  assert.equal(demo.hostGraceEndsAtMs, null);
  recordPlayerSuspension(demo, hostId, 'gps-denied');
  assert.equal(demo.players[0].connectionState, 'suspended');
  assert.equal(
    demo.hostGraceEndsAtMs,
    null,
    "'gps-denied' must not start a grace — the host keeps the crown with no succession clock",
  );
  assert.match(
    demo.announcements.at(-1).text,
    /suspended \(gps-denied\)/,
    'the announcement still names the reason (now from the typed union)',
  );
});

test('V3: a tab-hidden suspension still starts the host grace', () => {
  const demo = createRoom('Teo', TEST_CONFIG);
  const hostId = demo.players[0].playerId;
  recordPlayerSuspension(demo, hostId, 'tab-hidden');
  assert.equal(demo.players[0].connectionState, 'suspended');
  assert.ok(
    typeof demo.hostGraceEndsAtMs === 'number' && demo.hostGraceEndsAtMs > Date.now(),
    "'tab-hidden' must still start the 30 s host grace (GRACE_START_REASONS gate intact)",
  );
});

test('V3 (wiring pin): recordPlayerSuspension takes the typed union, not string', () => {
  const src = readFileSync(
    new URL('../src/lib/demo-store.ts', import.meta.url),
    'utf8',
  );
  assert.ok(
    src.includes('export type DemoSuspensionReason = SuspensionReason | \'gps-denied\';'),
    'the demo reason must be the live union plus the demo-only gps-denied',
  );
  assert.ok(
    src.includes('reason: DemoSuspensionReason,'),
    'recordPlayerSuspension must take the typed union',
  );
  assert.ok(
    !src.includes('reason: string,'),
    'no untyped-string reason may remain on recordPlayerSuspension',
  );
});

// ---------------------------------------------------------------------------
// 5. Zara V4 — narrower isMapResourceError.
// ---------------------------------------------------------------------------

test('V4: a plain JS error containing the word "load" is NOT a resource error', () => {
  const event = { error: { message: 'Failed to load user settings' } };
  assert.equal(
    isMapResourceError(event),
    false,
    '"Failed to load user settings" is an app/JS error — no resource word, no status, no url, no tile',
  );
  assert.equal(classifyMapError(true, event).kind, 'post-load-non-resource');
});

test('V4: a real tile / sprite / style-load failure still is a resource error', () => {
  assert.equal(
    isMapResourceError({ tile: { tileID: { z: 14 } }, error: { message: 'HTTP 401' } }),
    true,
    'tile property is the positive tile signal',
  );
  assert.equal(
    isMapResourceError({ error: { message: 'Failed to load sprite' } }),
    true,
    'sprite load failure names the resource',
  );
  assert.equal(
    isMapResourceError({ error: { message: 'Failed to load style' } }),
    true,
    '"Failed to load style" names the resource in a load failure',
  );
  assert.equal(
    isMapResourceError({ error: { message: "Source layer 'x' does not exist" } }),
    true,
    'source/layer failure names the resource',
  );
  assert.equal(
    isMapResourceError({ error: { message: 'AJAXError: Not Found (404): https://tiles.example/1/2/3.pbf', status: 404, url: 'https://tiles.example/1/2/3.pbf' } }),
    true,
    'an AJAXError carries status + url — a fetch that was attempted',
  );
  assert.equal(
    isMapResourceError({ error: { message: 'Network request failed', status: undefined } }),
    true,
    '"network" is a genuine resource word',
  );
  // And the founder's TypeError still is not one.
  assert.equal(
    isMapResourceError({ error: { message: "Cannot read properties of null (reading '0')" } }),
    false,
  );
});

test('V4: a bare "style"/"fetch" with no resource failure in the sentence is NOT a resource error', () => {
  assert.equal(
    isMapResourceError({ error: { message: 'Invalid style value for font-family' } }),
    false,
    'bare "style" with no failure word no longer matches — it must appear in a load failure naming a resource',
  );
  assert.equal(
    isMapResourceError({ error: { message: 'Failed to fetch user settings' } }),
    false,
    'bare "fetch" no longer matches',
  );
  // …while a style failure DOES still match (resource + failure).
  assert.equal(
    isMapResourceError({ error: { message: 'style failed to load' } }),
    true,
    '"style failed to load" is a load failure naming the resource',
  );
});

// ---------------------------------------------------------------------------
// 6. Diya A1 — POSITION_UNAVAILABLE copy.
// ---------------------------------------------------------------------------

/**
 * Run `fn` with `globalThis.navigator` replaced by `fake`. Node 24
 * exposes `navigator` as a getter-only property on the global, so a
 * plain assignment throws — swap the property descriptor instead and
 * restore it afterwards.
 */
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

test('A1: POSITION_UNAVAILABLE maps to an unavailability message, not a roughness one', async () => {
  const seen = [];
  await withNavigator(
    {
      geolocation: {
        watchPosition: (_ok, onError) => {
          // A real GeolocationPositionError carries its constants on
          // the instance (error.POSITION_UNAVAILABLE === 2).
          onError({ code: 2, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
          return 7;
        },
        clearWatch: () => {},
      },
    },
    async () => {
      const handle = watchLocation(
        () => seen.push('fix'),
        (err) => seen.push(err),
      );
      assert.equal(seen.length, 1, 'the error must reach onError (it is surfaced, not swallowed)');
      assert.equal(seen[0].kind, 'position-unavailable');
      assert.equal(
        seen[0].message,
        'GPS is unavailable right now — tap the map to place the zone.',
      );
      assert.doesNotMatch(seen[0].message, /too rough/, 'unavailability is not roughness');
      handle?.stop();
    },
  );
});

test('A1 (pin): the permission-denied message is unchanged', async () => {
  const seen = [];
  await withNavigator(
    {
      geolocation: {
        watchPosition: (_ok, onError) => {
          onError({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
          return 7;
        },
        clearWatch: () => {},
      },
    },
    async () => {
      const handle = watchLocation(
        () => {},
        (err) => seen.push(err),
      );
      assert.equal(seen[0].kind, 'permission-denied');
      assert.equal(
        seen[0].message,
        'Location is off — allow it in your browser settings, then tap the map to place the zone.',
      );
      handle?.stop();
    },
  );
});

// ---------------------------------------------------------------------------
// 7 + 9. Socket harness — one connected socket per test.
// ---------------------------------------------------------------------------

async function connectOpenSocket(t, extraOptions = {}) {
  const states = [];
  const socket = new PakdamSocket({
    roomId: 'ROOM1',
    playerId: 'P1',
    connectTimeoutMs: 5000,
    heartbeatIntervalMs: 30_000,
    onSnapshot: () => {},
    onStateChange: (s, d) => states.push([s, d]),
    ...extraOptions,
  });
  t.after(() => {
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  });
  const connecting = socket.connect();
  await sleep(0); // let the ticket fetch resolve and the socket be created
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws, 'connect() must create a WebSocket');
  ws.open();
  await connecting;
  // 'connected' arrives with the server's `welcome`, not with the
  // open — deliver it, as the DO would on hello.
  ws.onmessage?.({ data: JSON.stringify({ type: 'welcome' }) });
  assert.equal(socket.connectionState, 'connected');
  return { socket, ws, states };
}

test('A2: two quick hide/show cycles must not stack two snapshot retry chains', async (t) => {
  const { socket, ws } = await connectOpenSocket(t);
  // Spy on the public re-request — the chains' only observable effect
  // is how many snapshot requests they send.
  let calls = 0;
  const orig = socket.requestSnapshot.bind(socket);
  socket.requestSnapshot = () => {
    calls += 1;
    return orig();
  };
  // The socket dies silently (no onclose): the client has not noticed,
  // so every re-request returns false and the retry chain is the only
  // recovery. readyState is flipped directly — no close event fires.
  ws.readyState = 3;
  // Hide → show #1: re-request dropped → resync → chain 1 starts.
  doc.hidden = true;
  doc.dispatch('visibilitychange');
  doc.hidden = false;
  doc.dispatch('visibilitychange');
  assert.equal(calls, 1, 'show #1 must attempt one re-request');
  // Hide → show #2, immediately: chain 1 is still pending (2 s).
  doc.hidden = true;
  doc.dispatch('visibilitychange');
  doc.hidden = false;
  doc.dispatch('visibilitychange');
  assert.equal(calls, 2, 'show #2 must attempt one re-request');
  // One chain: exactly ONE retry fires at +2 s. Two stacked chains
  // (the pre-fix shape: the second resync reset the counter and
  // scheduled a second chain) would fire TWO.
  await sleep(2500);
  assert.equal(
    calls,
    3,
    `two quick hide/show cycles must leave ONE retry chain (3 re-requests by +2.5 s: 2 from the shows + 1 retry) — got ${calls}`,
  );
});

test('A3: a socket stuck in CONNECTING must time out into the existing retry path', async (t) => {
  const states = [];
  const socket = new PakdamSocket({
    roomId: 'ROOM1',
    playerId: 'P1',
    connectTimeoutMs: 50,
    heartbeatIntervalMs: 30_000,
    onSnapshot: () => {},
    onStateChange: (s, d) => states.push([s, d]),
  });
  t.after(() => {
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  });
  const connecting = socket.connect();
  await sleep(0);
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws, 'connect() must create a WebSocket');
  // Never opened: no onopen, no onerror, no onclose — the pre-fix
  // shape hung here in 'connecting' forever.
  await connecting;
  assert.equal(
    socket.connectionState,
    'reconnecting',
    'the connect timeout must land in the existing reconnect path, not hang in connecting',
  );
  assert.ok(
    states.some(([s, d]) => s === 'reconnecting' && /timed out/i.test(d ?? '')),
    `the reconnect detail must name the timeout — got ${JSON.stringify(states)}`,
  );
  // The stuck socket's eventual onclose must NOT schedule a second
  // reconnect on top of the one from the timeout (pre-fix: two
  // schedules, a leaked timer, a double-counted attempt).
  const reconnectingBefore = states.filter(([s]) => s === 'reconnecting').length;
  ws.drop(1006);
  await sleep(50);
  const reconnectingAfter = states.filter(([s]) => s === 'reconnecting').length;
  assert.equal(
    reconnectingAfter,
    reconnectingBefore,
    'the onclose of the timed-out socket must not schedule a second reconnect',
  );
  assert.equal(socket.connectionState, 'reconnecting');
});

// ---------------------------------------------------------------------------
// 8. Diya A5 + A6 — the two comment/note fixes.
// ---------------------------------------------------------------------------

test('A5 (pin): the dot-effect comment names the 5 s clock, not the 1 s clock', () => {
  const src = readFileSync(
    new URL('../src/components/hud/PlayMap.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(
    src.includes('advances on the 5 s clock'),
    'the stale-fade comment must say 5 s (mapNowMs is quantised to 5 s)',
  );
  assert.ok(
    !src.includes('advances on the 1 s clock'),
    'no comment may still claim the 1 s clock for the map prop',
  );
});

test('A6: the Ranchi fallback note says the zone was unusable, not absent', () => {
  const { RECENTRE_DEFAULT_NOTE, resolveRecentreCentre } = logic;
  assert.equal(
    RECENTRE_DEFAULT_NOTE,
    'Centred on Ranchi — no GPS fix and no usable zone.',
  );
  // A malformed zone (a non-finite vertex) EXISTS but falls back to
  // the default — the old "no zone yet" was wrong for exactly this.
  const out = resolveRecentreCentre(null, [
    { lng: 85.3096, lat: 23.3441 },
    { lng: Number.NaN, lat: 23.3441 },
    { lng: 85.3146, lat: 23.3541 },
  ]);
  assert.equal(out.source, 'default', 'a malformed boundary falls back to the default');
});
