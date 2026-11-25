/**
 * v33 FIX 2 (narrowed) + Zara 4 + 4405 client companions —
 * replay / lobby return / ejected results (Arjun, QA).
 *
 * FIX 2 NARROWED (coordinator, after Diya's review):
 * - the non-host waiting line RENDERS and RESOLVES (test both);
 * - a fresh-game route exists on the results page for EVERY seat
 *   state (host, guest, removed, ejected);
 * - rejoin-with-code is offered for `leftAt` seats only, never for
 *   ejected seats mid-match (server enforcement is Kabir's
 *   v33-ejected-seat.test.mjs — NOT duplicated here; the client
 *   pins below are the offer/restore-path side).
 *
 * ZARA 4: a removed/ejected seat reaching the results page gets
 * its own result AND a way back that does NOT call the restore
 * path mid-match (the results seatRemoved branch must contain no
 * `joinLiveRoom` / `addPlayer` call).
 *
 * 4405 COMPANIONS (coordinator):
 * - the removal screen renders (not "Game not found") — the probe's
 *   403 SEAT_REMOVED branch calls markSeatRemoved (regression);
 * - the probe path: when the probe gets 403 SEAT_REMOVED but the
 *   client ALREADY knows `ejectedAt` from the pushed snapshot, the
 *   client keeps EJECTED state and does NOT flip to the seatRemoved
 *   branch (the probe's 403 catch must be gated on the seat not
 *   being ejected — FAILS now: the catch calls markSeatRemoved()
 *   unconditionally);
 * - the post-close probe APPLIES a successful state fetch (does
 *   not discard it) — the LOBBY effect then resolves via HTTP fetch
 *   as well as socket snapshots, so a non-host on results follows
 *   a host replay even with a dead socket (FAILS now: the probe's
 *   `.then` discards the fetched state);
 * - the ejected banner on the play page offers a results button
 *   that works without the socket (FAILS now: text only).
 *
 * HOST-ONLY REPLAY AUTHORITY is preserved throughout: a non-host
 * replay attempt is refused and never resets the room (demo-store
 * behaviour tests below, all passing — the authority already
 * holds; these pin it against regressions).
 *
 * SERVER TESTS ARE NOT DUPLICATED: Kabir's
 * workers/test/v33-ejected-seat.test.mjs (11 tests) covers
 * getStateOp refusal, the four ticket refusals, get-results
 * playerIds-only, the restore refusals, the verifyHost ejected
 * gate, the five 4405 ejection paths, alarm() snapshot-before-
 * close, untouched live sockets, and deleted ejected sessions.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const {
  createRoom,
  replayDemoRoom,
  leaveRoom,
  ejectPlayer,
} = await import('../src/lib/demo-store.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

const TEST_CONFIG = {
  ...DEFAULT_ROOM_CONFIG,
  hostOnSiteConfirmed: true,
  headStartSeconds: 0,
  durationSeconds: 600,
  zone: {
    boundary: [
      { lat: 23.3441, lng: 85.3096 },
      { lat: 23.3441, lng: 85.3196 },
      { lat: 23.3541, lng: 85.3146 },
    ],
    shrinkPhases: [],
  },
};

const resultsSrc = readFileSync(
  new URL('../src/app/room/[roomId]/results/page.tsx', import.meta.url),
  'utf8',
);
const lobbySrc = readFileSync(
  new URL('../src/app/room/[roomId]/page.tsx', import.meta.url),
  'utf8',
);
const playSrc = readFileSync(
  new URL('../src/app/room/[roomId]/play/page.tsx', import.meta.url),
  'utf8',
);
const hookSrc = readFileSync(
  new URL('../src/components/match/useRoomState.ts', import.meta.url),
  'utf8',
);
const joinSrc = readFileSync(
  new URL('../src/app/join/[code]/page.tsx', import.meta.url),
  'utf8',
);

/** A demo room with host Teo + guest Ana, finished (COMPLETED). Phase is assigned directly: the phase machine is covered by other tests; the behaviour under test here is the replay, not the transition. The guest is built by hand (the v30-happy-path pattern): `joinRoom` cannot run in node because the store persists through `window.localStorage`. */
function finishedDemo() {
  const demo = createRoom('Teo', TEST_CONFIG);
  const host = demo.players[0];
  const ana = {
    ...host,
    playerId: 'ana-player-id',
    displayName: 'Ana',
    isHost: false,
    isReady: false,
    briefingConfirmed: false,
    joinedAt: new Date(Date.parse(host.joinedAt) + 1000).toISOString(),
  };
  demo.players.push(ana);
  demo.room.phase = 'COMPLETED';
  demo.room.result = {
    outcome: 'hunters-win',
    durationSeconds: 120,
    caughtRunnerIds: [],
    survivingRunnerIds: [],
    tags: [],
  };
  return { demo, host, ana };
}

/** A demo room with host Teo + guest Ana, in ACTIVE (for the ejection setup). */
function activeDemo() {
  const demo = createRoom('Teo', TEST_CONFIG);
  const host = demo.players[0];
  const ana = {
    ...host,
    playerId: 'ana-player-id',
    displayName: 'Ana',
    isHost: false,
    isReady: false,
    briefingConfirmed: false,
    joinedAt: new Date(Date.parse(host.joinedAt) + 1000).toISOString(),
  };
  demo.players.push(ana);
  demo.room.phase = 'ACTIVE';
  return { demo, host, ana };
}

/** The results page's `seatRemoved` branch (from `if (seatRemoved) {` to the `if (error || !room)` that follows it). */
function seatRemovedBranch() {
  const start = resultsSrc.indexOf('if (seatRemoved) {');
  assert.ok(start >= 0, 'the results page must have a seatRemoved branch');
  const end = resultsSrc.indexOf('if (error || !room) {', start);
  assert.ok(end > start, 'the seatRemoved branch must end before the error branch');
  return resultsSrc.slice(start, end);
}

/** The socket-close probe block in useRoomState (from the probe's fetch to the end of its catch). */
function probeBlock() {
  const start = hookSrc.indexOf('void fetchLiveRoomState(roomId, session.playerId, session.reconnectToken)');
  assert.ok(start >= 0, 'the socket-close probe must exist in useRoomState');
  const end = hookSrc.indexOf('},\n      onError:', start);
  assert.ok(end > start, 'the probe block must end before onError');
  return hookSrc.slice(start, end);
}

/** The play page's ejected banner (from `{ejectedAt ? (` to its `) : null}`). */
function ejectedBanner() {
  const start = playSrc.indexOf('{ejectedAt ? (');
  assert.ok(start >= 0, 'the play page must have an ejectedAt banner');
  const end = playSrc.indexOf(') : null}', start);
  assert.ok(end > start, 'the ejected banner must close');
  return playSrc.slice(start, end);
}

// -- Demo-store replay: host-only authority (regression pins). ------------
test('v33 FIX 2: the host replays a finished room — back to LOBBY, same room/code/host, result cleared, roster kept', () => {
  const { demo, host, ana } = finishedDemo();
  const { roomId, roomCode, hostPlayerId } = demo.room;
  const out = replayDemoRoom(demo, host.playerId);
  assert.equal(out.room.phase, 'LOBBY');
  assert.equal(out.room.roomId, roomId, 'a replay keeps the room id');
  assert.equal(out.room.roomCode, roomCode, 'a replay keeps the code — no rejoin needed');
  assert.equal(out.room.hostPlayerId, hostPlayerId, 'a replay keeps the host');
  assert.equal(out.room.result, null, 'a replay clears the result');
  assert.deepEqual(
    out.players.map((p) => p.playerId).sort(),
    [host.playerId, ana.playerId].sort(),
    'a replay keeps the roster',
  );
});

test('v33 FIX 2: a non-host replay attempt is refused and never resets the room', () => {
  const { demo, ana } = finishedDemo();
  assert.throws(
    () => replayDemoRoom(demo, ana.playerId),
    /Only the host can replay the room\./,
  );
  assert.equal(demo.room.phase, 'COMPLETED', 'the refused attempt must not reset the room');
  assert.notEqual(demo.room.result, null, 'the result must survive a refused replay');
});

test('v33 FIX 2: a host replay of a non-terminal room is refused and changes nothing', () => {
  const demo = createRoom('Teo', TEST_CONFIG);
  const host = demo.players[0];
  demo.room.phase = 'ACTIVE';
  assert.throws(
    () => replayDemoRoom(demo, host.playerId),
    /Only a finished room can be replayed/,
  );
  assert.equal(demo.room.phase, 'ACTIVE');
});

test('v33 FIX 2: a left seat cannot replay — and stays left after the host replays', () => {
  const { demo, host, ana } = finishedDemo();
  leaveRoom(demo, ana.playerId);
  assert.throws(
    () => replayDemoRoom(demo, ana.playerId),
    /Only the host can replay the room\./,
  );
  replayDemoRoom(demo, host.playerId);
  assert.equal(demo.room.phase, 'LOBBY');
  const anaAfter = demo.players.find((p) => p.playerId === ana.playerId);
  assert.notEqual(anaAfter.leftAt, null, 'a left seat stays left after a replay');
});

test('v33 FIX 2: an ejected seat cannot replay — and its ejection clears only when the host replays', () => {
  const { demo, host, ana } = activeDemo();
  ejectPlayer(demo, ana.playerId);
  assert.notEqual(ana.ejectedAt, null, 'precondition: Ana is ejected');
  demo.room.phase = 'COMPLETED';
  assert.throws(
    () => replayDemoRoom(demo, ana.playerId),
    /Only the host can replay the room\./,
  );
  replayDemoRoom(demo, host.playerId);
  const anaAfter = demo.players.find((p) => p.playerId === ana.playerId);
  assert.equal(anaAfter.ejectedAt, null, 'a host replay clears the ejection for the next game');
});

// -- Results page: waiting line renders AND resolves. ----------------------
test('v33 FIX 2: the non-host waiting line renders on the results page', () => {
  // The replay block is an `isHost ?` ternary: the host gets the
  // replay button, the non-host gets the waiting line — never a
  // dead button.
  assert.match(
    resultsSrc,
    /\{isHost \? \([\s\S]{0,300}?Replay — back to the lobby[\s\S]{0,300}?\) : \([\s\S]{0,300}?Only the host can replay — waiting for the host\./,
    'a non-host must see the waiting line in the else-branch of the isHost ternary, not a replay button',
  );
});

test('v33 FIX 2: the LOBBY effect resolves via HTTP fetch as well as socket snapshots — the post-close probe APPLIES a successful state fetch', () => {
  // The results page's LOBBY effect (`if (phase === 'LOBBY')
  // router.replace(...)`) fires on ANY phase change — socket or
  // HTTP-applied. But the socket-close probe in useRoomState
  // DISCARDS a successful fetch today (`.then(() => {
  // deletedProbeRef.current = false; })`), so a non-host on results
  // with a dead socket never learns the host replayed: the phase
  // stays COMPLETED and the waiting line never resolves. v33: the
  // probe applies the fetched state (the first-paint fetch and the
  // Retry fetch already do — `applySnapshot(state)`).
  const probe = probeBlock();
  assert.match(probe, /fetchLiveRoomState\(roomId, session\.playerId, session\.reconnectToken\)/);
  assert.ok(
    /\.then\(\(\w+\) => \{[\s\S]*?applySnapshot\(\w+\)/.test(probe),
    'the probe must apply a successful state fetch (applySnapshot) instead of discarding it — otherwise the LOBBY effect can only resolve from a live socket',
  );
  assert.match(
    resultsSrc,
    /if \(phase === 'LOBBY'\) \{\s*router\.replace\(`\/room\/\$\{roomId\}`\);/,
    'the LOBBY effect itself must redirect on phase LOBBY',
  );
});

// -- Results page: a fresh-game route for EVERY seat state. ----------------
test('v33 FIX 2: a fresh-game route exists for host and guest seats (regression)', () => {
  assert.match(resultsSrc, /START A FRESH GAME/, 'the main results branch must offer a fresh game');
});

test('v33 FIX 2: a fresh-game route exists for removed AND ejected seats too', () => {
  // The seatRemoved branch (which an ejected seat also lands in —
  // getStateOp 403s it with SEAT_REMOVED) used to have only "Go
  // home". Meera landed the v33 routes: "Start a fresh game" (home,
  // labelled as the fresh-game route — the old "Go home" label is
  // gone by design) plus "Join the lobby again" when the stored
  // session carries a room code (a fresh join, server-gated to
  // LOBBY — it clears the session first, so it can never restore
  // an ejected seat mid-match).
  const branch = seatRemovedBranch();
  assert.match(
    branch,
    /Start a fresh game/i,
    'the removed/ejected branch must offer a labelled fresh-game route',
  );
  assert.match(
    branch,
    /Join the lobby again/,
    'the removed/ejected branch must offer the lobby return when a room code is stored',
  );
});

test('v33 FIX 2: the removed/ejected branch names the ejection — an ejected seat must not read "The host removed you"', () => {
  const branch = seatRemovedBranch();
  assert.match(branch, /You were removed from the game\./);
  // NOTE: match on RENDERED copy only — the branch carries a v33
  // comment mentioning "an ejected seat", which must not count as
  // the ejected copy. An ejected seat must READ different words
  // ("You were ejected…", "away too long…") or see a conditional
  // branch on ejected state.
  const rendered = branch
    .replace(/\{ *\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(
    /eject/i.test(rendered),
    'the branch must distinguish an ejected seat in its rendered copy (ejected wording or an ejected-state conditional) — today it hardcodes "The host removed you from this game." for both',
  );
});

test('v33 FIX 2 / Zara 4: the removed/ejected branch never calls the restore path mid-match', () => {
  const branch = seatRemovedBranch();
  assert.ok(!/joinLiveRoom/.test(branch), 'no fresh-join call in the removed branch');
  assert.ok(!/addPlayer/.test(branch), 'no restore (addPlayer) call in the removed branch');
  assert.ok(!/storeLiveSeat/.test(branch), 'no seat-store call in the removed branch');
});

// -- Lobby page: terminal phases must not loop to /play. -------------------
test('v33 FIX 2: the lobby page handles terminal phases — a COMPLETED room does not push a returning non-host to /play', () => {
  // Today every lobby guard is `if (state.room.phase !== 'LOBBY')
  // goPlay();` — a non-host returning to the lobby while the room
  // is COMPLETED (after the host replayed, or on a stale tab) is
  // pushed to /play, which bounces them straight back to results:
  // a loop with no way into the lobby. The guards must exempt
  // terminal phases (COMPLETED / isTerminalPhase / TERMINAL_PHASES).
  assert.ok(
    /COMPLETED|isTerminalPhase|TERMINAL_PHASES/.test(lobbySrc),
    'the lobby page must name terminal phases — today it has no COMPLETED handling at all',
  );
});

// -- 4405 companions: probe keeps EJECTED; removal screen; results button.
test('v33 4405: the probe keeps EJECTED state — a 403 SEAT_REMOVED on a seat the client already knows is ejected does NOT flip it to the seatRemoved branch', () => {
  // The server deliberately reuses SEAT_REMOVED for ejected reads
  // (Kabir: a new code would fall through to "Game not found"), and
  // the client learns `ejectedAt` from the pushed snapshot BEFORE
  // the 4405 close lands. So when the probe's fetch 403s with
  // SEAT_REMOVED, the client must check whether it already knows
  // the seat is ejected — and keep the EJECTED state (ejected
  // banner / ejected results copy) instead of calling
  // markSeatRemoved() and showing "The host removed you". Today
  // the probe's catch calls markSeatRemoved() unconditionally.
  const probe = probeBlock();
  assert.ok(
    /ejectedAt/.test(probe),
    'the probe’s 403 SEAT_REMOVED branch must consult ejectedAt before marking the seat removed',
  );
});

test('v33 4405 (regression): a 403 SEAT_REMOVED from the probe marks the seat removed — the removal screen renders, not "Game not found"', () => {
  const probe = probeBlock();
  assert.match(probe, /err\.code === 'SEAT_REMOVED'/);
  assert.match(probe, /markSeatRemoved\(\)/, 'the probe must mark the seat removed on a SEAT_REMOVED refusal');
});

test('v33 4405: the play-page ejected banner offers a results button that works without the socket', () => {
  // The ejected banner is text only today ("you can watch the
  // results when the round ends, or join a new game") — no button.
  // After the 4405 close the socket is dead, so the button must be
  // a plain navigation (router.push to /results), not a socket call.
  const banner = ejectedBanner();
  assert.match(banner, /You were removed from the game\./);
  assert.ok(
    /<Button|onClick/.test(banner),
    'the ejected banner must offer a results button — today it is text only, so an ejected seat with a dead socket has no way to its result from the play page',
  );
});

// -- Rejoin-with-code: leftAt only (client side of Kabir's restore gate). --
test('v33 FIX 2: the join-by-code rejoin offer restores the stored seat — it never mints a fresh seat', () => {
  // handleRejoin restores the stored session (storeLiveSeat with
  // the saved reconnect token) and navigates to the room, where the
  // existing resume path runs (role/score intact). A fresh join
  // would mint a new seat and strand the old one. The server
  // enforces the rest (Kabir: ejected restore 403s mid-match, left
  // restore is LOBBY-only) — the client must not bypass it by
  // joining fresh under the same name.
  assert.match(joinSrc, /getRejoinTokenForCode\(code\)/);
  assert.match(joinSrc, /storeLiveSeat\(\{/);
  assert.match(joinSrc, /router\.push\(`\/room\/\$\{rejoinEntry\.roomId\}`\)/);
  const rejoinStart = joinSrc.indexOf('const handleRejoin');
  const joinStart = joinSrc.indexOf('const join = async', rejoinStart);
  assert.ok(rejoinStart >= 0 && joinStart > rejoinStart, 'handleRejoin must exist');
  const handleRejoin = joinSrc.slice(rejoinStart, joinStart);
  assert.ok(!/joinLiveRoomByCode/.test(handleRejoin), 'handleRejoin must not call the fresh-join path');
});
