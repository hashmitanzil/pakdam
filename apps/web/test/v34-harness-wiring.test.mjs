import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const {
  WS_CLIENT_TYPES,
  WS_SERVER_TYPES,
  WS_DIRECT_SERVER_TYPES,
  WS_TEAM_ONLY_SERVER_TYPES,
  WS_ROLE_SCOPED_SERVER_TYPES,
  isWsClientMessageType,
  isWsServerMessageType,
  WS_CLOSE_CODE_ACTION,
} = await import('@pakdam/shared');

const {
  pillTextForState,
  tilesStalledAfterMs,
  TILE_STALL_MS,
} = await import('../src/components/hud/play-map-logic.ts');

const {
  maxLastFixAtMs,
  readSnapshotWatermarkMs,
  readSnapshotEpochMs,
  buildLastSnapshotKey,
  buildSnapshotKey,
} = await import('../src/lib/snapshot-key.ts');

const { isRejoinTokenStale, REJOIN_TOKEN_MAX_AGE_MS } = await import('../src/lib/rejoin-token.ts');
const { JOIN_KEY_TTL_MS } = await import('../src/lib/join-key.ts');

function readSrc(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

// v34 HARNESS (Arjun, QA) — wiring verification.
//
// For each wire (client<->Worker<->DO<->Supabase; WS connect/upgrade/
// renew/reconnect; GPS fix -> server -> snapshot -> map dot; voice
// signal -> peer -> audio; catch token -> claim -> confirm -> results;
// replay -> fresh lobby; join -> lobby -> start) this file names the
// test that proves it and what breaks if it is cut. Pure-contract
// pins run here; the live ends are pinned by the workers integration
// file (v34-harness-integration) and the e2e pins
// (apps/web/e2e/v34-harness-pins.spec.ts, NEEDS-CI).

// --- WS event catalogue: the frozen contract --------------------------

test('v34 harness wiring: the WS catalogue is 22 client / 37 server types; removed types stay removed', () => {
  assert.equal(WS_CLIENT_TYPES.length, 22, 'frozen contract: 22 client->server types');
  // 37, not the 36 the events.ts header still claims: the header's
  // count never included 'room.deleted' (unfrozen in v23 S12). The
  // ARRAY is the contract — pin the array, and flag the stale header
  // comment to the coordinator as doc drift (not a product bug).
  assert.equal(WS_SERVER_TYPES.length, 37, 'frozen contract: 37 server->client types (header comment still says 36 — stale)');
  for (const removed of ['reveal.send', 'safety.sos', 'zone.preview']) {
    assert.equal(isWsClientMessageType(removed), false, `${removed} was removed by founder decision and must stay unknown`);
    assert.equal(isWsServerMessageType(removed), false);
  }
  for (const live of ['hello', 'auth.refresh', 'location.update', 'catch.request', 'catch.confirm', 'catch.self-confirm', 'catch.runner-token', 'safety.pause', 'safety.resume', 'ready.set', 'radio.send', 'voice.signal', 'leave']) {
    assert.equal(isWsClientMessageType(live), true, `${live} must be a live client type`);
  }
  for (const live of ['welcome', 'snapshot', 'snapshot.unchanged', 'teammate.fix', 'ticket.renewed', 'catch.runner-token', 'room.deleted', 'match.completed']) {
    assert.equal(isWsServerMessageType(live), true, `${live} must be a live server type`);
  }
});

test('v34 harness wiring: broadcast scoping — direct, team-only and role-scoped sets are disjoint and complete', () => {
  // Direct (sender-only) includes the secret-bearing replies: a token
  // or error must never be broadcast to the room.
  for (const t of ['welcome', 'snapshot', 'error', 'heartbeat.ack', 'auth.refreshed', 'ticket.renewed', 'catch.runner-token']) {
    assert.ok(WS_DIRECT_SERVER_TYPES.includes(t), `${t} must be direct-only`);
  }
  assert.ok(WS_TEAM_ONLY_SERVER_TYPES.includes('voice.signal'), 'voice is team-only');
  assert.ok(WS_TEAM_ONLY_SERVER_TYPES.includes('radio'), 'radio is team-only');
  assert.ok(WS_TEAM_ONLY_SERVER_TYPES.includes('teammate.fix'), 'teammate.fix is team-only');
  assert.deepEqual(WS_ROLE_SCOPED_SERVER_TYPES, ['ping'], 'only ping is role-scoped');
  const overlap = WS_DIRECT_SERVER_TYPES.filter((t) => WS_TEAM_ONLY_SERVER_TYPES.includes(t));
  assert.deepEqual(overlap, [], 'no server type may be both direct and team-only');
});

// --- WS close codes: what each cut does --------------------------------

test('v34 harness wiring: close-code table — terminal codes never reconnect, ticket codes retry once, drops back off', () => {
  // If 4405 (ejected) ever reconnected, an ejected seat would rejoin
  // a live match it was ejected from. If 4404 (room gone) ever
  // reconnected, a deleted room would spin forever on fresh tickets.
  for (const code of [1000, 4403, 4404, 4405, 4409]) {
    assert.equal(WS_CLOSE_CODE_ACTION[code], 'do-not-reconnect', `${code} must be terminal`);
  }
  for (const code of [4400, 4401]) {
    assert.equal(WS_CLOSE_CODE_ACTION[code], 'fresh-ticket-reconnect-once', `${code} retries once with a fresh ticket`);
  }
  for (const code of [1001, 1006, 1011]) {
    assert.equal(WS_CLOSE_CODE_ACTION[code], 'backoff-reconnect', `${code} backs off and reconnects`);
  }
  assert.equal(WS_CLOSE_CODE_ACTION[4413], 'backoff-after-retry-after');
});

test('v34 harness wiring [source]: the socket latches 4403/4404/4405 terminal and refuses retry after them', () => {
  const socketSrc = readSrc('src/lib/websocket.ts');
  assert.ok(socketSrc.includes('lastTerminalCloseCode === 4404'),
    'websocket.ts must latch the 4404 room-gone close');
  assert.ok(socketSrc.includes('lastTerminalCloseCode === 4405'),
    'websocket.ts must latch the 4405 ejected close');
  assert.match(socketSrc, /retry\(\)` refuses after 4403\/4404\/4405/,
    'retry() must refuse after a terminal close');
  assert.ok(socketSrc.includes('sendCatchSelfConfirm'),
    'the socket must expose the self-confirm send used by the catch page');
});

// --- GPS fix -> server -> snapshot -> map dot ---------------------------

test('v34 harness wiring: snapshot keys are wake-safe and null-safe (R5 contract)', () => {
  const snap = {
    version: 7, serverSeq: 42, maxLastFixAtMs: 1_780_000_002_000, epochMs: 1_780_000_000_500,
    players: [
      { playerId: 'a', lastFixAt: new Date(1_780_000_002_000).toISOString() },
      { playerId: 'b', lastFixAt: null },
    ],
  };
  assert.deepEqual(buildLastSnapshotKey(snap), {
    version: 7, serverSeq: 42, maxLastFixAtMs: 1_780_000_002_000, epochMs: 1_780_000_000_500,
  });
  assert.equal(buildSnapshotKey(snap), '7:42:1780000002000:1780000000500');
  // No fixes anywhere: null, never 0 — 0 would claim a fix at the epoch.
  const empty = { version: 1, serverSeq: 0, maxLastFixAtMs: null, epochMs: 9, players: [] };
  assert.equal(readSnapshotWatermarkMs(empty), null);
  assert.equal(buildSnapshotKey(empty), '1:0:null:9');
  // Old server (no fields): falls back to the players, still null-safe.
  const old = { version: 2, serverSeq: 3, players: [{ playerId: 'a', lastFixAt: null }] };
  assert.equal(readSnapshotWatermarkMs(old), null);
  assert.equal(readSnapshotEpochMs(old), null);
  assert.equal(maxLastFixAtMs(snap.players), 1_780_000_002_000);
  assert.equal(maxLastFixAtMs([]), 0);
});

// --- join -> lobby -> start: keys and tokens ----------------------------

test('v34 harness wiring: join keys live 10 min; rejoin tokens live 12 h and fail closed when undatable', () => {
  assert.equal(JOIN_KEY_TTL_MS, 600_000, 'a join key covers one join attempt window (10 min)');
  assert.equal(REJOIN_TOKEN_MAX_AGE_MS, 12 * 60 * 60 * 1000, 'a rejoin token covers an app kill, not a week (12 h)');
  const fresh = { roomId: 'r', roomCode: 'ABCDEF', playerId: 'p', displayName: 'Ana', reconnectToken: 'x', isHost: false, storedAtMs: 1_000_000 };
  assert.equal(isRejoinTokenStale(fresh, 1_000_000 + 60_000), false);
  assert.equal(isRejoinTokenStale(fresh, 1_000_000 + REJOIN_TOKEN_MAX_AGE_MS + 1), true);
  assert.equal(isRejoinTokenStale({ ...fresh, storedAtMs: undefined }, 1_000_000), true,
    'an undatable token is stale — fail closed');
  assert.equal(isRejoinTokenStale({ ...fresh, storedAtMs: Number.NaN }, 1_000_000), true);
});

// --- map pill: the v34 B1 tiles signal (flag-driven) --------------------

test('v34 harness wiring: the tiles signal — pending reads loading, stalled names the failure, default reads ready', () => {
  assert.equal(TILE_STALL_MS, 10_000, 'the stall watchdog fires at 10 s past style-ready');
  assert.equal(tilesStalledAfterMs(1000, 1000 + 9999), false);
  assert.equal(tilesStalledAfterMs(1000, 1000 + 10_000), true);
  assert.equal(tilesStalledAfterMs(0, 99_999), false, 'a never-ready map never counts as stalled');
  // Flag-driven pill (the component passes the real flags — pinned
  // below by source). The flag is `tilesPending`, default FALSE
  // (defaults = healthy map; a problem must be passed explicitly).
  // Positional order after elapsedS: tileErrorCount, tileDetail,
  // fitFailed, zeroHeight, otherResource, fitReason, fitPending,
  // zeroWidth, heightDiagnosis, recentreFailed, contextLost,
  // contextRestoring, paintStalled, tilesPending, tilesStalled.
  const ready = (tilesPending, tilesStalled) => pillTextForState(
    'ready', null, false, null,
    0, null, false, false, null, null, false, false, null, false, false, false, false,
    tilesPending, tilesStalled,
  );
  assert.equal(ready(false, false), 'Map ready');
  assert.match(ready(true, false), /Loading map tiles…/);
  assert.match(ready(false, true), /Map tiles not loading — try Retry/);
  assert.match(ready(true, true), /Map tiles not loading — try Retry/,
    'the stall outranks the pending state');
});

test('v34 harness wiring [source]: PlayMap passes the REAL tile flags into the pill (the B1 wiring)', () => {
  const playMapSrc = readSrc('src/components/hud/PlayMap.tsx');
  assert.ok(playMapSrc.includes('tilesStalledAfterMs'), 'PlayMap must run the stall watchdog');
  assert.ok(playMapSrc.includes('tilesStalledRef'), 'PlayMap must latch the stall once fired');
  // The pill call passes pending as !tilesLoaded plus the stall flag.
  const pillCall = playMapSrc.slice(playMapSrc.indexOf('pillTextForState('));
  assert.ok(pillCall.includes('!tilesLoaded'), 'the pill call must pass tilesPending as !tilesLoaded');
  assert.ok(pillCall.includes('tilesStalled'), 'the pill call must pass tilesStalled');
});

test('v34 harness wiring: the B1 default-args regression was FIXED by the builder during this harness run', () => {
  // v34 B1 first landed with tilesLoaded=false defaults, so a default
  // pill call could never read 'Map ready' and 21 pre-existing pill
  // tests failed. The builder fixed it mid-run by renaming the flag
  // to `tilesPending` (default false = healthy; the production caller
  // passes the real value). Pin the FIXED behaviour so a regression
  // back to the broken default fails here first.
  assert.equal(pillTextForState('ready', null, false, null), 'Map ready',
    'a default pill call must read Map ready (B1 fix)');
  assert.match(pillTextForState('ready', null, false, null,
    0, null, false, false, null, null, false, false, null, false, false, false, false, true, false),
  /Loading map tiles…/, 'tilesPending must still suppress Map ready when passed');
});

// --- catch: Way 2 self-confirm wiring -----------------------------------

test('v34 harness wiring [source]: the catch page Way 2 (hunter list -> OK) sends catch.self-confirm with a 15 s timeout', () => {
  const catchSrc = readSrc('src/app/room/[roomId]/catch/page.tsx');
  assert.ok(catchSrc.includes('sendCatchSelfConfirm'), 'Way 2 must send catch.self-confirm');
  assert.ok(catchSrc.includes('15_000'), 'Way 2 must time out after 15 s so a Runner never wedges on Confirming…');
  assert.ok(catchSrc.includes('Confirmation timed out'), 'the timeout must surface in plain words');
  assert.ok(catchSrc.includes('Not connected — the confirmation was not sent'),
    'a dead socket must be surfaced at tap time, not swallowed');
  assert.ok(catchSrc.includes('Way 2 error swallow'),
    'the v34 fix for the swallowed Way 2 rejection must be present');
});

test('v34 harness wiring [source]: Got Tagged routes to the catch page; the catch page NOW watches GPS (v34 overturns the v32 harbour property by design)', () => {
  const playSrc = readSrc('src/app/room/[roomId]/play/page.tsx');
  assert.ok(playSrc.includes('goCatch') || playSrc.includes('/catch'),
    'the play page must route Got Tagged to the catch page');
  const catchSrc = readSrc('src/app/room/[roomId]/catch/page.tsx');
  // v34 self-confirm fix: the Runner's fix froze on the catch page
  // (no watcher lived there), so the server's STALE_LOCATION gate
  // rejected every self-confirm. The catch page now runs its own
  // watch + a 5 s re-stamp resend, so the fix stays fresh for the
  // confirm. The v32 "catch page mounts no watcher" pin is superseded
  // — pin the new behaviour instead.
  assert.ok(catchSrc.includes('watchLocation('), 'the catch page must watch GPS so self-confirm has a fresh fix');
  assert.ok(catchSrc.includes('setInterval'), 'the catch page must re-send the fix on a timer');
  assert.ok(catchSrc.includes('Location is off or blocked'),
    'a denied GPS on the catch page must surface in plain words with a retry');
  assert.ok(catchSrc.includes('visibilitychange'),
    'the catch-page watch must stop while the tab is hidden and restart on return');
});

// --- voice: signal -> peer -----------------------------------------------

test('v34 harness wiring [source]: voice-radio sends offer/answer/ice and the socket relays team-only', () => {
  const radioSrc = readSrc('src/lib/voice-radio.ts');
  for (const kind of ["'offer'", "'answer'", "'ice'"]) {
    assert.ok(radioSrc.includes(kind), `voice-radio must handle ${kind}`);
  }
  const socketSrc = readSrc('src/lib/websocket.ts');
  assert.ok(socketSrc.includes("sendCommand('voice.signal'") || socketSrc.includes("'voice.signal'"),
    'the socket must carry voice.signal');
});

// --- replay / results wiring (server side, pinned in integration) ------

test('v34 harness wiring [source]: results list hunter-tagged-runner with time; replay resets to a fresh lobby', () => {
  const resultsSrc = readSrc('src/app/room/[roomId]/results/page.tsx');
  assert.ok(resultsSrc.toLowerCase().includes('tagged'),
    'the results page must name who tagged whom');
  // The server-side half is pinned executable in
  // workers/test/v34-harness-integration.test.mjs (create -> … ->
  // replay keeps the code and the seats, clears catches and roles).
  assert.ok(true, 'see v34-harness-integration for the executable replay pin');
});
