/**
 * v31 fix-round (web) tests (Meera) — F3 client half, keyed off Kabir's
 * server contract.
 *
 * Server contract (workers/src/room-do.ts, `getStateOp`): after
 * `verifyReconnect`, a `leftAt !== null` seat is refused with
 * `errResult('That seat has left the room.', 'SEAT_REMOVED', 403)` —
 * deleted-room 404 stays first. `doError` (workers/src/http.ts) passes
 * the code through into the `{ error, code }` envelope. `resultsFor`
 * has NO `leftAt` check, so a left seat can still read `get-results`.
 *
 * Client half, pinned here:
 *  (1) the envelope is READ on the GET path — `fetchLiveRoomState`
 *      used to throw `new LiveHttpError(response.status)` and discard
 *      the body, so `SEAT_REMOVED` read exactly like a bare 403;
 *  (2) `useRoomState` keys the removal off the CODE, never the bare
 *      status — a 403 without `SEAT_REMOVED` (bad token) keeps the
 *      old generic error;
 *  (3) the hook latches `seatRemoved` (mirror dies, no Retry) from
 *      the first-paint fetch, the manual Retry, the socket-close
 *      probe, and a snapshot that lands with my seat's `leftAt` set;
 *  (4) play / catch / lobby / setup show the removal screen instead
 *      of the generic error; results shows the leaver's own result
 *      from `get-results` (outcome, duration, my score) — the full
 *      named results screen stays out of reach, because `get-results`
 *      carries playerIds, not display names.
 *
 * The live HTTP helpers are tested for real (stubbed fetch); the hook
 * and pages need React, so their wiring is pinned by source.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

globalThis.window = {
  sessionStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
  localStorage: {
    get length() {
      return 0;
    },
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    key: () => null,
  },
};

process.env.NEXT_PUBLIC_WORKER_URL = 'https://worker.test';

/** Mutable fetch behaviour — each test installs its own response. */
let fetchResponse = null;
globalThis.fetch = async () => {
  if (!fetchResponse) throw new Error('fetch stub has no response installed');
  return fetchResponse;
};

function errorResponse(status, body) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

const {
  LiveHttpError,
  readLiveErrorEnvelope,
} = await import('../src/lib/live-client.ts');
const { fetchLiveRoomState } = await import('../src/lib/live-room-client.ts');
const { fetchLiveResults } = await import('../src/lib/live-client.ts');

// -- (1) the envelope is read on the GET path. --------------------------
test('fetchLiveRoomState surfaces 403 SEAT_REMOVED with its code, not a bare status', async () => {
  fetchResponse = errorResponse(403, {
    error: 'That seat has left the room.',
    code: 'SEAT_REMOVED',
  });
  let caught = null;
  try {
    await fetchLiveRoomState('room-1', 'p1', 'tok-1');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof LiveHttpError);
  assert.equal(caught.status, 403);
  assert.equal(caught.code, 'SEAT_REMOVED');
  assert.equal(caught.message, 'That seat has left the room.');
});

test('fetchLiveRoomState keeps code undefined when the body carries none (bare 403 stays bare)', async () => {
  fetchResponse = errorResponse(403, { error: 'Forbidden.' });
  let caught = null;
  try {
    await fetchLiveRoomState('room-1', 'p1', 'tok-1');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof LiveHttpError);
  assert.equal(caught.status, 403);
  assert.equal(caught.code, undefined);
  assert.equal(caught.message, 'Forbidden.');
});

test('fetchLiveResults (the GET helper) carries the code too', async () => {
  fetchResponse = errorResponse(403, {
    error: 'Seat not found or reconnect token does not match.',
    code: 'FORBIDDEN',
  });
  let caught = null;
  try {
    await fetchLiveResults('room-1', 'p1', 'tok-1');
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof LiveHttpError);
  assert.equal(caught.status, 403);
  assert.equal(caught.code, 'FORBIDDEN');
});

test('readLiveErrorEnvelope reads message + code from one body parse; an unreadable body reads as {}', async () => {
  const envelope = await readLiveErrorEnvelope({
    json: async () => ({ error: 'That seat has left the room.', code: 'SEAT_REMOVED' }),
  });
  assert.deepEqual(envelope, {
    message: 'That seat has left the room.',
    code: 'SEAT_REMOVED',
  });
  assert.deepEqual(
    await readLiveErrorEnvelope({ json: async () => { throw new Error('not json'); } }),
    {},
  );
  assert.deepEqual(
    await readLiveErrorEnvelope({ json: async () => ({}) }),
    {},
  );
});

// -- (2)/(3)/(4) source pins: the hook and the pages. -------------------
const useRoomStateSrc = readFileSync(
  new URL('../src/components/match/useRoomState.ts', import.meta.url),
  'utf8',
);
const playSrc = readFileSync(
  new URL('../src/app/room/[roomId]/play/page.tsx', import.meta.url),
  'utf8',
);
const catchSrc = readFileSync(
  new URL('../src/app/room/[roomId]/catch/page.tsx', import.meta.url),
  'utf8',
);
const resultsSrc = readFileSync(
  new URL('../src/app/room/[roomId]/results/page.tsx', import.meta.url),
  'utf8',
);
const lobbySrc = readFileSync(
  new URL('../src/app/room/[roomId]/page.tsx', import.meta.url),
  'utf8',
);
const setupSrc = readFileSync(
  new URL('../src/app/room/[roomId]/setup/page.tsx', import.meta.url),
  'utf8',
);

function countCodeBranches(src) {
  return (src.match(/err\.code === 'SEAT_REMOVED'/g) ?? []).length;
}

test('source pin: the hook keys removal off the CODE in exactly three places — never a bare 403', () => {
  // First paint, socket-close probe, manual Retry. A bare 403 (bad
  // token, no code) must keep the old generic error in all three.
  assert.equal(countCodeBranches(useRoomStateSrc), 3);
  assert.match(useRoomStateSrc, /seatRemoved: boolean;/);
  assert.match(useRoomStateSrc, /const \[seatRemoved, setSeatRemoved\] = useState\(false\);/);
  assert.match(
    useRoomStateSrc,
    /const markSeatRemoved = useCallback\(\(\) => \{\n\s*clearRejoinToken\(roomId\);/,
    'markSeatRemoved kills the mirror with the seat',
  );
});

test('source pin: the hook latches seatRemoved and refuses Retry for a removed seat', () => {
  assert.match(useRoomStateSrc, /if \(roomDeleted \|\| seatRemoved\) return;/);
  assert.match(
    useRoomStateSrc,
    /err\.status === 403 &&\n\s*err\.code === 'SEAT_REMOVED'\n\s*\) \{\n\s*markSeatRemoved\(\);/,
    'the Retry catch marks the seat removed instead of retrying the socket',
  );
});

test('source pin: play + catch show the removal screen, with no Retry, when the seat is removed', () => {
  for (const [name, src] of [
    ['play', playSrc],
    ['catch', catchSrc],
  ]) {
    assert.match(src, /seatRemoved,/, `${name}: seatRemoved is read from the hook`);
    assert.match(src, /if \(seatRemoved\) \{/, `${name}: removal branch before the generic error gate`);
    assert.match(
      src,
      /No Retry: a removed seat can never reload/,
      `${name}: the removal screen offers no Retry`,
    );
  }
});

test('source pin: lobby + setup key removal off the CODE too, and show the removal screen', () => {
  // Lobby: first paint, socket-close probe, manual Retry. Setup: first
  // paint, socket-close probe (it has no socket retry).
  assert.equal(countCodeBranches(lobbySrc), 3);
  assert.equal(countCodeBranches(setupSrc), 2);
  for (const [name, src] of [
    ['lobby', lobbySrc],
    ['setup', setupSrc],
  ]) {
    assert.match(src, /const \[seatRemoved, setSeatRemoved\] = useState\(false\);/, `${name}: seatRemoved state`);
    assert.match(src, /if \(seatRemoved\) \{/, `${name}: removal branch before the loading skeleton`);
  }
});

test('source pin: results renders the leaver’s own result from get-results, not the error screen', () => {
  assert.match(resultsSrc, /seatRemoved,/, 'results reads seatRemoved from the hook');
  assert.match(resultsSrc, /if \(seatRemoved\) \{/, 'results has a removal branch before the error gate');
  assert.match(
    resultsSrc,
    /const \[liveResult, setLiveResult\] = useState/,
    'the full get-results response is kept, not just the scores',
  );
  assert.match(resultsSrc, /You scored \{myScore\}/, 'the branch shows MY score from get-results');
  assert.match(
    resultsSrc,
    /if \(seatRemoved\) setLiveResultMissing\(true\);/,
    'a 404 while removed records "not finished yet" instead of spinning',
  );
});
