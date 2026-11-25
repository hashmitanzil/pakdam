/**
 * v32 hand-pick tests (Meera) — host-setup:150/:168 + the spec-side pins
 * for error-boundary:32, live-hud:54/:207 and host-setup:138.
 *
 * Product defect (host-setup:150/:168): turning Random OFF pre-picked
 * hunters the host never chose — `normaliseConfig` in the lobby/setup
 * pages filled the pick up to the effective count with the first roster
 * rows, so the roster read "2 of 2 Hunters picked" before a single tap
 * and one tap could never show "1 of 2". The pages now trim only (never
 * fill) and save a team-assignment change with one `updateRoomConfig`
 * call, which persists the full config (including `randomDraw`) and
 * clears the pick — the old `setTeamAssignment` path never wrote
 * `randomDraw`, so the 1 s poll reverted the Random toggle/hint.
 *
 * These tests pin the store contract the pages rely on (demo-store is
 * imported read-only here — Kabir owns that file; the pages' own
 * `normaliseConfig` is inline in the React pages, so its wiring is
 * pinned by the e2e specs + the source pins below, not rendered here).
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

function makeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
    _map: map,
  };
}

const sessionStorageStub = makeStorage();
const localStorageStub = makeStorage();

globalThis.document = {
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = {
  sessionStorage: sessionStorageStub,
  localStorage: localStorageStub,
};

const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');
const {
  createRoom,
  joinRoom,
  getRoom,
  updateRoomConfig,
  setSelectedHunters,
} = await import('../src/lib/demo-store.ts');

const TRIANGLE = [
  { lat: 23.36, lng: 85.33 },
  { lat: 23.37, lng: 85.33 },
  { lat: 23.365, lng: 85.34 },
];

/** A 3-player demo lobby (Teo host + Ana + Ben), defaults. */
function makeThreePlayerLobby() {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    durationSeconds: 1800,
    hostOnSiteConfirmed: true,
    zone: { boundary: TRIANGLE, shrinkPhases: [] },
  };
  const demo = createRoom('Teo', config);
  const ana = joinRoom(demo.room.roomId, 'Ana').player;
  joinRoom(demo.room.roomId, 'Ben');
  return { roomId: demo.room.roomId, anaId: ana.playerId };
}

// -- host-setup:150: Random OFF starts at 0 of 2 --------------------------
test('hand-pick (150): Random OFF persists randomDraw=false and starts at 0 picks', () => {
  const { roomId } = makeThreePlayerLobby();
  // Balance OFF first, exactly as the spec does.
  let demo = getRoom(roomId);
  updateRoomConfig(demo, { ...demo.room.config, balanceHunters: false });
  // Random OFF — the pages' single updateRoomConfig save (the old
  // setTeamAssignment path never wrote randomDraw, so the 1 s poll
  // reverted the toggle/hint from the stale store value).
  demo = getRoom(roomId);
  updateRoomConfig(demo, {
    ...demo.room.config,
    randomDraw: false,
    teamAssignment: 'selected',
  });
  const saved = getRoom(roomId).room.config;
  assert.equal(saved.teamAssignment, 'selected');
  assert.equal(saved.randomDraw, false);
  assert.deepEqual(saved.selectedHunterIds, []);
});

// -- host-setup:168: one tap picks exactly one Hunter ---------------------
test('hand-pick (168): one roster tap saves exactly one pick', () => {
  const { roomId, anaId } = makeThreePlayerLobby();
  let demo = getRoom(roomId);
  updateRoomConfig(demo, { ...demo.room.config, balanceHunters: false });
  demo = getRoom(roomId);
  updateRoomConfig(demo, {
    ...demo.room.config,
    randomDraw: false,
    teamAssignment: 'selected',
  });
  // The roster tap: one pick, saved via updateRoomConfig (a partial
  // pick is valid — the start gate enforces the exact count, never
  // this save).
  demo = getRoom(roomId);
  updateRoomConfig(demo, {
    ...demo.room.config,
    selectedHunterIds: [anaId],
  });
  assert.deepEqual(getRoom(roomId).room.config.selectedHunterIds, [anaId]);
});

// -- The trap the old branch fell into ------------------------------------
test('hand-pick trap: setSelectedHunters demands exactly hunterCount, so the pages must not call it with a short pick', () => {
  const { roomId } = makeThreePlayerLobby();
  const demo = getRoom(roomId);
  assert.throws(
    () => setSelectedHunters(demo, []),
    /Pick exactly 2 Hunters/,
  );
});

// -- host-setup:138: the no-zone line appears exactly once ----------------
test('source pin (138): the no-zone line is rendered once, in SetupControls only', () => {
  const line =
    'No zone and no pings. Classic hide and seek — hunters get no locations at all.';
  const countOccurrences = (src) => src.split(line).length - 1;
  const setupSrc = readFileSync(
    new URL('../src/app/room/[roomId]/setup/page.tsx', import.meta.url),
    'utf8',
  );
  const controlsSrc = readFileSync(
    new URL('../src/components/host-setup/SetupControls.tsx', import.meta.url),
    'utf8',
  );
  // The setup page rendered the same sentence a second time, so the
  // spec's getByText matched two elements (strict-mode violation).
  assert.equal(countOccurrences(setupSrc), 0);
  assert.equal(countOccurrences(controlsSrc), 1);
});

// -- error-boundary:32: the report override must be CSP-allowlisted ------
test('source pin (error-boundary): the bug-report override is same-origin, never worker.example', () => {
  const specSrc = readFileSync(
    new URL('../e2e/error-boundary.spec.ts', import.meta.url),
    'utf8',
  );
  // CSP connect-src allow-lists only 'self' + the real Worker / Ola
  // origins: a report to a non-allowlisted origin is CSP-blocked in
  // the browser, so the mocked route never fires and the report
  // assertion times out while the fallback itself renders fine.
  assert.equal(
    /__pakdamTestWorkerUrl\s*=\s*window\.location\.origin/.test(specSrc),
    true,
  );
  assert.equal(specSrc.includes('worker.example'), false);
});

// -- live-hud:54/:207: the spec-side fixes --------------------------------
test('source pin (live-hud:54): the never-reported label is asserted on a guest seat', () => {
  const specSrc = readFileSync(
    new URL('../e2e/live-hud.spec.ts', import.meta.url),
    'utf8',
  );
  // v32 fix round (Diya A2): the old pin asserted the wrong element.
  // The host's own dot cannot show it after the bringToFront resume
  // (resumePlayer stamps lastFixAt), and a teammate dot exists only
  // when the host drew Runner — so the host page matches zero or one
  // elements by role draw. A guest seat never resumed, so it is still
  // suspended — deterministic (Diya-verified) — and no fix ever
  // arrived for it. But its YOU dot reads 'Suspended', not 'Location
  // never reported' (play/page.tsx:1166-1174); the never-reported
  // half lives in the suspended banner (`formatSuspendedLabel`,
  // freshness.ts:38-44). The spec must assert the banner's full exact
  // text on the guest page — never the bare label with `.first()`,
  // which could match the banner or a teammate dot instead of the
  // YOU dot.
  assert.equal(
    specSrc.includes(
      "guestPages[0]!.getByText('Suspended — location unknown · Location never reported'",
    ),
    true,
  );
  assert.equal(specSrc.includes(".getByText('Location never reported').first()"), false);
});

test('source pin (live-hud:207): the suspended-banner test grants geolocation', () => {
  const specSrc = readFileSync(
    new URL('../e2e/live-hud.spec.ts', import.meta.url),
    'utf8',
  );
  // Without it the watch errors permission-denied at mount, the seat
  // suspends for GPS-denied and v30 hides "Resume sharing" while GPS
  // is denied — the button this test clicks never renders.
  assert.equal(specSrc.includes("permissions: ['geolocation']"), true);
  assert.equal(
    specSrc.includes('geolocation: { latitude: 23.36, longitude: 85.33'),
    true,
  );
});
