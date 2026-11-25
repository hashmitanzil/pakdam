/**
 * v33 FIX 1 (re-scoped) + 4405 socket companions — watch lifecycle,
 * suspend delivery, and the ejected close code (Arjun, QA).
 *
 * FIELD EVIDENCE (founder's phone, live v31, room NSLYY3, 2026-11-25
 * ~15:51 IST): 2-player game, founder is the Hunter (Hskaowg), jhgf
 * the Runner, 8:14 left, zone 375 m. The YOU chip read "Location is
 * off" + "Try again" (0:16 ago) → the 30 s missing-fix rule ejected
 * the founder → the map went BLACK with a "Map ready" pill (a fix HAD
 * arrived by then) → catch page "Match over". The founder confirmed
 * location was ON at the phone level — the game did not connect to it.
 *
 * CORRECTION (Diya's adversarial review, 2026-11-25 — the FIRST
 * version of this file pinned the WRONG theory and has been
 * rewritten): Diya verified the watch STAYS ALIVE on a transient
 * error (unavailable/timeout) and "Try again" IS a real restart — so
 * there is NO auto-retry to add in `watchLocation`, and the four
 * retry tests from the first draft are deleted, not merely skipped.
 * The REAL Fix 1 defect is SUSPEND DELIVERY: `reportSuspended`
 * goes through `sendCommand`, and the socket's own contract (R12,
 * websocket.ts) is "commands sent while disconnected are discarded,
 * never queued". When the GPS watch dies/is denied while the socket
 * is down (reconnecting after an app-switch / network flap), the
 * suspension notice is silently dropped — the DO never learns the
 * seat is suspended, the (4a) exemption never applies, and the 30 s
 * missing-fix rule ejects a seat whose phone location was ON.
 * v33 FIX 1: a suspension reported while the socket is down is
 * QUEUED (not discarded) and flushed on (re)connect, and the play
 * page re-asserts the suspension on hello-resume while the watch is
 * dead/denied (`gpsDenied`).
 *
 * 4405 COMPANIONS (Diya + coordinator): the server now closes an
 * ejected seat with the NEW distinct code 4405 (workers, v33 F2b —
 * `EJECTED_CLOSE_CODE`, reason 'You were ejected from the game.'),
 * never 4403. The client must handle it with EJECTED copy (not the
 * 4403 "Seat removed or revoked." copy) and must not retry after it
 * (an ejected seat has no live-socket business). `WS_CLOSE_CODE_ACTION`
 * already maps 4405 → 'do-not-reconnect' (shared) — that part is a
 * regression pin.
 *
 * DRIVER: a real `PakdamSocket` against a fake `WebSocket` class, a
 * stubbed ticket `fetch`, a stubbed `window.sessionStorage` holding
 * the seat, and a stubbed `document` — the production connect/hello/
 * welcome path, not a bypass. Every test closes its socket so no
 * heartbeat/reconnect timer survives the test process.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const { watchLocation } = await import('../src/lib/geolocation.ts');
const { PakdamSocket } = await import('../src/lib/websocket.ts');
const { WS_CLOSE_CODE_ACTION, SESSION_STORAGE_KEY } = await import(
  '@pakdam/shared'
);

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

// -- Play-page source (regression + re-assert pins). -----------------------
const playSrc = readFileSync(
  new URL('../src/app/room/[roomId]/play/page.tsx', import.meta.url),
  'utf8',
);

// -- PakdamSocket driver ---------------------------------------------------
/** Minimal WebSocket stand-in: the test drives open/deliver/close by hand. */
class FakeWebSocket {
  static OPEN = 1;

  static CONNECTING = 0;

  static CLOSED = 3;

  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED;
    if (typeof this.onclose === 'function') this.onclose({ code, reason });
  }

  /** Test drive: the socket opens (hello is sent by the client). */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    if (typeof this.onopen === 'function') this.onopen();
  }

  /** Test drive: deliver one server envelope to the client. */
  deliver(envelope) {
    if (typeof this.onmessage === 'function') {
      this.onmessage({ data: JSON.stringify(envelope) });
    }
  }

  sentOfType(type) {
    return this.sent.filter((m) => m.type === type);
  }
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
  };
}

/**
 * Install the globals `PakdamSocket` needs and return a cleanup + a
 * `connect(socket)` helper that drives the ticket fetch, the fake
 * socket open, and the server `welcome` — i.e. a fully connected
 * socket. `fetchCalls` counts ticket fetches (the retry-refusal pin).
 */
function installSocketGlobals({ roomId, playerId }) {
  const prevWebSocket = globalThis.WebSocket;
  const prevFetch = globalThis.fetch;
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevWorkerUrl = process.env.NEXT_PUBLIC_WORKER_URL;
  FakeWebSocket.instances.length = 0;
  const fetchCalls = { count: 0 };
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async () => {
    fetchCalls.count += 1;
    return {
      ok: true,
      json: async () => ({
        ok: true,
        ticket: `tick-${fetchCalls.count}`,
        ticketId: `tid-${fetchCalls.count}`,
        expiresAtMs: Date.now() + 60_000,
      }),
    };
  };
  const session = JSON.stringify([
    { mode: 'live', roomId, playerId, reconnectToken: 'tok-1', hostToken: '' },
  ]);
  globalThis.window = {
    sessionStorage: memoryStorage({ [SESSION_STORAGE_KEY]: session }),
    localStorage: memoryStorage(),
  };
  globalThis.document = {
    hidden: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  process.env.NEXT_PUBLIC_WORKER_URL = 'https://worker.example';
  return {
    fetchCalls,
    async connect(socket) {
      const connecting = socket.connect();
      // Let the ticket fetch resolve and the fake socket be constructed.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const ws = FakeWebSocket.instances.at(-1);
      assert.ok(ws, 'connect() must construct a WebSocket');
      ws.open();
      await connecting;
      ws.deliver({ type: 'welcome' });
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(socket.connectionState, 'connected', 'welcome must connect the socket');
      return ws;
    },
    cleanup() {
      globalThis.WebSocket = prevWebSocket;
      globalThis.fetch = prevFetch;
      if (prevWindow === undefined) delete globalThis.window;
      else globalThis.window = prevWindow;
      if (prevDocument === undefined) delete globalThis.document;
      else globalThis.document = prevDocument;
      if (prevWorkerUrl === undefined) delete process.env.NEXT_PUBLIC_WORKER_URL;
      else process.env.NEXT_PUBLIC_WORKER_URL = prevWorkerUrl;
      FakeWebSocket.instances.length = 0;
    },
  };
}

function makeSocket({ roomId = 'room-1', playerId = 'p1' } = {}) {
  const states = [];
  const socket = new PakdamSocket({
    roomId,
    playerId,
    heartbeatIntervalMs: 60_000,
    connectTimeoutMs: 5_000,
    onSnapshot: () => {},
    onStateChange: (state, detail) => states.push([state, detail]),
    onError: () => {},
  });
  return { socket, states };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -- watchLocation regression pins (the Diya-verified behaviour). ---------
test('v33 FIX 1 (regression): PERMISSION_DENIED is terminal — exactly one watch, no retry', async () => {
  const state = { watchCalls: 0, cleared: [] };
  const errors = [];
  await withNavigator(
    {
      geolocation: {
        watchPosition: (_ok, onError) => {
          state.watchCalls += 1;
          onError(errorWith(1));
          return state.watchCalls;
        },
        clearWatch: (id) => state.cleared.push(id),
      },
    },
    async () => {
      const handle = watchLocation(
        () => {},
        (err) => errors.push(err),
      );
      assert.equal(state.watchCalls, 1, 'a denial creates exactly one watch');
      assert.equal(errors.length, 1);
      assert.equal(errors[0].kind, 'permission-denied');
      handle?.stop();
      assert.deepEqual(state.cleared, [1]);
    },
  );
});

test('v33 FIX 1 (regression): a single TIMEOUT does not kill the OS watch — a later fix on the SAME watch still delivers', async () => {
  let deliveredOk = null;
  let cleared = null;
  await withNavigator(
    {
      geolocation: {
        watchPosition: (onOk, onError) => {
          deliveredOk = onOk;
          onError(errorWith(3));
          return 7;
        },
        clearWatch: (id) => {
          cleared = id;
        },
      },
    },
    async () => {
      const fixes = [];
      const errors = [];
      const handle = watchLocation(
        (fix) => fixes.push(fix),
        (err) => errors.push(err),
      );
      assert.equal(errors.length, 1);
      assert.equal(errors[0].kind, 'timeout');
      assert.equal(cleared, null, 'a timeout must never clearWatch — the OS watch stays alive');
      deliveredOk(position({ timestampMs: Date.now() }));
      assert.equal(fixes.length, 1, 'the post-timeout fix must reach onFix');
      handle?.stop();
      assert.equal(cleared, 7);
    },
  );
});

test('v33 FIX 1 (regression): a single POSITION_UNAVAILABLE is surfaced with the v28 message', async () => {
  const seen = [];
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
      const handle = watchLocation(
        () => {},
        (err) => seen.push(err),
      );
      assert.equal(seen.length, 1);
      assert.equal(seen[0].kind, 'position-unavailable');
      assert.equal(seen[0].message, 'GPS is unavailable right now — tap the map to place the zone.');
      handle?.stop();
    },
  );
});

test('v33 FIX 1 (regression): the play page starts the watch on mount', () => {
  assert.match(
    playSrc,
    /const startWatch = \(\) => \{[\s\S]{0,300}?watchHandleRef\.current = watchLocation\(onFix, onError\);/,
    'startWatch must create the watch through watchLocation',
  );
  assert.match(playSrc, /startWatch\(\);\n {4}document\.addEventListener\('visibilitychange', onVisibility\);/);
});

test('v33 FIX 1 (regression): the watch survives tab-hide/show — hidden stops it, visible restarts it', () => {
  assert.match(playSrc, /document\.addEventListener\('visibilitychange', onVisibility\)/);
  assert.match(playSrc, /if \(document\.hidden\) \{[\s\S]{0,500}?stopWatch\(\);/);
  const onVisibility = playSrc.slice(playSrc.indexOf('const onVisibility'));
  assert.match(onVisibility, /startWatch\(\);/, 'the visible branch must restart the watch');
});

test('v33 FIX 1 (regression): "Try again" re-runs the watcher effect (explicit tap only, never automatic)', () => {
  assert.match(playSrc, /Try again/);
  assert.match(playSrc, /onClick=\{\(\) => setGpsRetryNonce\(\(n\) => n \+ 1\)\}/);
  assert.match(
    playSrc,
    /\[roomId, myPlayerId, mode, phase, gpsRetryNonce\]/,
    'the watcher effect must depend on gpsRetryNonce so the tap re-creates the watch',
  );
  assert.match(
    playSrc,
    /re-runs it on an explicit "Try again" tap after a GPS denial/,
  );
});

test('v33 FIX 1 (regression): shouldWatchLocation still gates on running phase + visible tab', async () => {
  const { shouldWatchLocation } = await import(
    '../src/components/hud/play-map-logic.ts'
  );
  assert.equal(shouldWatchLocation('ACTIVE', false), true);
  assert.equal(shouldWatchLocation('HEAD_START', false), true);
  assert.equal(shouldWatchLocation('SAFETY_PAUSED', false), true);
  assert.equal(shouldWatchLocation('ACTIVE', true), false, 'a hidden tab never watches');
  assert.equal(shouldWatchLocation('COMPLETED', false), false, 'a terminal phase never watches');
  assert.equal(shouldWatchLocation('LOBBY', false), false);
});

// -- FIX 1 (real defect): suspend delivery while the socket is down. ------
test('v33 FIX 1: reportSuspended while the socket is DOWN is queued and flushed on connect — never silently discarded', async () => {
  const g = installSocketGlobals({ roomId: 'room-1', playerId: 'p1' });
  const { socket } = makeSocket();
  try {
    // The founder's case: the watch is dead/denied while the socket
    // is down (reconnecting after an app-switch). Today the call
    // returns false and the suspension is gone (R12). The pin is
    // the DELIVERY on (re)connect, not the return value: a fix may
    // queue the report while still returning false (not yet sent).
    socket.reportSuspended('unknown');
    const ws = await g.connect(socket);
    const suspended = ws.sentOfType('player.suspended');
    assert.equal(
      suspended.length,
      1,
      `the queued suspension must be flushed on (re)connect (hello + suspension expected, got ${JSON.stringify(ws.sent.map((m) => m.type))})`,
    );
    assert.equal(suspended[0].payload.reason, 'unknown');
  } finally {
    socket.close();
    g.cleanup();
  }
});

test('v33 FIX 1 (regression): reportSuspended while CONNECTED still sends at once', async () => {
  const g = installSocketGlobals({ roomId: 'room-1', playerId: 'p1' });
  const { socket } = makeSocket();
  try {
    const ws = await g.connect(socket);
    assert.equal(socket.reportSuspended('tab-hidden'), true);
    const suspended = ws.sentOfType('player.suspended');
    assert.equal(suspended.length, 1);
    assert.equal(suspended[0].payload.reason, 'tab-hidden');
  } finally {
    socket.close();
    g.cleanup();
  }
});

test('v33 FIX 1: a queued suspension flushes ONCE — a later reconnect without a new report sends nothing again', async () => {
  const g = installSocketGlobals({ roomId: 'room-1', playerId: 'p1' });
  const { socket } = makeSocket();
  try {
    socket.reportSuspended('unknown');
    const ws1 = await g.connect(socket);
    assert.equal(
      ws1.sentOfType('player.suspended').length,
      1,
      'precondition: the queue flushes on the first connect',
    );
    // Drop (1006, transient) and let the reconnect loop fire a fresh
    // socket: backoff base 1 s, jitter 0.5–1.0, so 2 s covers it.
    ws1.close(1006, '');
    await sleep(2000);
    const ws2 = FakeWebSocket.instances.at(-1);
    assert.ok(ws2 && ws2 !== ws1, 'the reconnect must have opened a fresh socket');
    ws2.open();
    ws2.deliver({ type: 'welcome' });
    await sleep(0);
    assert.equal(
      ws2.sentOfType('player.suspended').length,
      0,
      'the drained queue must not re-send on a later reconnect — a second suspension would re-mark an already-resumed seat',
    );
  } finally {
    socket.close();
    g.cleanup();
  }
});

test('v33 FIX 1: the play page re-asserts the suspension on hello-resume while the watch is dead/denied', () => {
  // The socket-side queue covers a report made while DOWN. The
  // page-side half: after a reconnect lands while `gpsDenied` is
  // still true, the page re-sends `reportSuspended('unknown')` —
  // the DO only exempts the seat from the 30 s rule while it KNOWS
  // the seat is suspended. Today the only call site is the onError
  // handler inside the watcher effect (line ~591); a second call
  // site must exist in a separate effect that reads the `gpsDenied`
  // state (not `setGpsDenied` — the setter is the onError site).
  const chunks = playSrc.split(/useEffect\(/g);
  const reporting = chunks.filter((c) => /reportSuspended\(/.test(c));
  assert.ok(
    reporting.length >= 2,
    `expected a second reportSuspended call site outside the watcher effect (found ${reporting.length} useEffect chunk(s) mentioning it)`,
  );
  assert.ok(
    reporting.some((c) => /\bgpsDenied\b/.test(c)),
    'the re-assert must be gated on the gpsDenied state — a blind re-send would suspend a healthy seat',
  );
});

// -- 4405 companions (client side of Kabir's server F2b). -----------------
test('v33 4405: WS_CLOSE_CODE_ACTION already maps 4405 to do-not-reconnect (regression)', () => {
  assert.equal(WS_CLOSE_CODE_ACTION[4405], 'do-not-reconnect');
  assert.equal(WS_CLOSE_CODE_ACTION[4403], 'do-not-reconnect');
});

test('v33 4405: a 4405 close lands with the EJECTED copy — never the 4403 copy, never a bare close', async () => {
  const g = installSocketGlobals({ roomId: 'room-1', playerId: 'p1' });
  const { socket, states } = makeSocket();
  try {
    const ws = await g.connect(socket);
    ws.close(4405, 'You were ejected from the game.');
    await sleep(0);
    const closed = states.filter(([s]) => s === 'closed');
    assert.equal(closed.length, 1, 'a 4405 must end the socket in state closed');
    const detail = closed[0][1];
    assert.ok(
      typeof detail === 'string' && /eject|away too long|location stopped/i.test(detail),
      `a 4405 close must carry ejected copy, not the 4403 copy (got ${JSON.stringify(detail)})`,
    );
    assert.notEqual(detail, 'Seat removed or revoked.', '4405 must not reuse the 4403 copy');
  } finally {
    socket.close();
    g.cleanup();
  }
});

test('v33 4405: retry() after a 4405 close is a no-op — no fresh ticket, no new socket', async () => {
  const g = installSocketGlobals({ roomId: 'room-1', playerId: 'p1' });
  const { socket } = makeSocket();
  try {
    const ws = await g.connect(socket);
    const fetchesBefore = g.fetchCalls.count;
    ws.close(4405, 'You were ejected from the game.');
    await sleep(0);
    await socket.retry();
    await sleep(0);
    assert.equal(
      g.fetchCalls.count,
      fetchesBefore,
      'retry() after 4405 must not fetch a ticket — an ejected seat cannot reconnect',
    );
    assert.equal(
      FakeWebSocket.instances.length,
      1,
      'retry() after 4405 must not open a new socket',
    );
  } finally {
    socket.close();
    g.cleanup();
  }
});

test('v33 4405 (control): a 4403 close keeps the removed copy AND refuses retry', async () => {
  const g = installSocketGlobals({ roomId: 'room-1', playerId: 'p1' });
  const { socket, states } = makeSocket();
  try {
    const ws = await g.connect(socket);
    const fetchesBefore = g.fetchCalls.count;
    ws.close(4403, 'Seat removed.');
    await sleep(0);
    const closed = states.filter(([s]) => s === 'closed');
    assert.equal(closed[0][1], 'Seat removed or revoked.');
    await socket.retry();
    await sleep(0);
    assert.equal(g.fetchCalls.count, fetchesBefore, 'retry() after 4403 stays refused');
    assert.equal(FakeWebSocket.instances.length, 1);
  } finally {
    socket.close();
    g.cleanup();
  }
});
