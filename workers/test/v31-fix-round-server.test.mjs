import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const { RoomStore, emptyMemory } = await import('../src/room-do.ts');
const { hashHostToken } = await import('../src/auth.ts');
const { DEFAULT_ROOM_CONFIG } = await import('@pakdam/shared');

// v31 FIX ROUND (server) — Kabir.
//
// F3 (AT RISK): a seat removed while its tab is discarded resurrected
// as if still in the game. `removePlayer` closes live sockets with
// 4403, but a discarded tab has no socket and nothing cleared its
// localStorage mirror; on return `getStateOp` verified only the
// reconnect-token hash and served the snapshot. Contract DECIDED:
// `getStateOp` REFUSES a `leftAt`-set seat (403, code SEAT_REMOVED).
// The other option — carry the seat's `leftAt` in the response — was
// rejected because the snapshot ALREADY carries it (every player view
// spreads `leftAt`; `playerViewFor` in @pakdam/engine snapshot.ts,
// via `RoomStore.snapshotFor`); the data was never missing, the
// server was still serving it to a seat that is out. The refusal is
// on `getStateOp` only, NOT in `verifyReconnect`: the shared verifier
// must stay permissive so `resultsFor` still serves a mid-game leaver
// (pinned below) and the restore path (`addPlayerAsync`, which clears
// `leftAt` on name + token) keeps working. Callers checked: `get-state`
// is first-paint / re-sync for one's own seat only (GET /v1/rooms/:id);
// results use the separate `get-results` op; the lobby's socket-close
// probe only acts on 404, so a 403 is ignored there; a deleted room
// still 404s first. The hello path was audited too: registerTicket
// (409), redeemTicketForConnect (4403), resumeOnHello (no-op unless
// suspended — a left seat is `disconnected`, never `suspended`) and
// handleWsMessage (4403 close) already refuse `leftAt` seats, so the
// HTTP state read was the only hole. The audit also found
// `issueHostToken` minting for a left host (sole-host leave keeps
// `isHost`); the minted token was dead on arrival (`verifyHost`
// refuses `leftAt`), but the guard is added anyway.
//
// Zara (c) (AppSec note): revoke had no DO-side rate limit — the
// Worker limiter is per-isolate in-memory, so a valid seat holder
// spreading revoke calls across isolates could force more than 10
// `save()`s/min (the class saves unconditionally after a revoke).
// Added `checkTicketRevokeRateLimit`, a deliberate mirror of
// `checkTicketIssueRateLimit` (same sliding-window shape, own memory
// map `ticketRevokes`, own table entry 10/min/seat); a 429 returns
// before mutating, so it costs no save either.
//
// F6 (AT RISK): two live tabs restoring the same host seat ping-pong
// the host token — `issueHostToken` unconditionally overwrites
// `state.hostTokens[playerId]` on every mint. LEFT UNFIXED: the
// "return the existing valid token" fix is impossible server-side
// (only the HASH is stored, never the raw token), and the remaining
// server-side shape (previous-hash grace) changes durable state and
// weakens the "previous token dies" rotation guarantee. Pinned below
// as a DOCUMENTED test so the mechanism is visible until the fix
// lands; the pinning test for the fix is in the fix-round report.
const T0 = 1_780_000_000_000;

const TRIANGLE = [
  { lat: 23.3, lng: 85.28 },
  { lat: 23.3, lng: 85.38 },
  { lat: 23.4, lng: 85.33 },
];

function player(playerId, displayName, isHost = false) {
  return {
    playerId,
    roomId: 'room-1',
    kind: 'guest',
    displayName,
    isHost,
    matchRole: null,
    team: null,
    reconnectTokenHash: `reconnect-hash-${playerId}`,
    joinedAt: new Date(T0 - 1000).toISOString(),
    leftAt: null,
    ejectedAt: null,
    connectionState: 'connected',
    lastFixAt: null,
    locationQuality: null,
    isReady: true,
    briefingConfirmed: true,
    ageGatePassed: true,
    suspensionCount: 0,
  };
}

function makeStore({ hunters = ['hu1'], runners = ['r1'] } = {}) {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    headStartSeconds: 0,
    pingIntervalSeconds: 0,
    durationSeconds: 3600,
    zoneShrinkEnabled: false,
    zoneShrinkIntervalSeconds: 60,
    playZoneEnabled: true,
    zone: { boundary: TRIANGLE, shrinkPhases: [] },
    teamAssignment: 'selected',
    selectedHunterIds: [...hunters],
    hunterCount: hunters.length,
    balanceHunters: false,
    randomDraw: false,
  };
  const players = [
    player('h1', 'Host', true),
    ...hunters.map((id, i) => player(id, `Hunter ${i + 1}`)),
    ...runners.map((id, i) => player(id, `Runner ${i + 1}`)),
  ];
  const state = {
    room: {
      roomId: 'room-1',
      roomCode: 'ABCDEF',
      hostPlayerId: 'h1',
      phase: 'LOBBY',
      version: 1,
      config,
      createdAt: new Date(T0 - 1000).toISOString(),
      startedAt: null,
      endsAt: null,
      pausedAt: null,
      result: null,
    },
    players,
    catches: [],
    hostTokens: { h1: 'host-hash' },
    serverSeq: 0,
    gameEventLog: [],
    lastPingAtMs: {},
    paused: false,
    pausedBy: null,
    pausedFrom: null,
    eventLog: [],
    shrinkIndexApplied: 0,
    tickets: [],
    idempotency: [],
    idempotentReplies: [],
    pendingPings: [],
    pendingPingRecipients: {},
    runnerQrTokens: [],
  };
  return new RoomStore(state, emptyMemory());
}

function start(store, atMs = T0) {
  const r = store.startMatch({ playerId: 'h1', hostTokenHash: 'host-hash', nowMs: atMs });
  assert.equal(r.ok, true, `startMatch must succeed: ${r.ok ? '' : r.error}`);
  return r;
}

// ---------------------------------------------------------------------------
// F3 — removed-while-away seat cannot read state / cannot rejoin
// ---------------------------------------------------------------------------

test('v31 FIX ROUND (F3): getStateOp refuses a host-removed seat (403 SEAT_REMOVED) and still serves the rest', () => {
  const store = makeStore();
  const removed = store.removePlayer({
    playerId: 'h1',
    hostTokenHash: 'host-hash',
    targetPlayerId: 'r1',
    nowMs: T0,
  });
  assert.equal(removed.ok, true, `removePlayer must succeed: ${removed.ok ? '' : removed.error}`);
  assert.notEqual(store.player('r1').leftAt, null, 'the removal stamps leftAt');

  const gone = store.getStateOp({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 1000,
  });
  assert.equal(gone.ok, false, 'a removed seat must not read state');
  assert.equal(gone.status, 403);
  assert.equal(gone.code, 'SEAT_REMOVED', 'the client branches on the code, not the text');
  assert.match(gone.error, /left the room/);

  // Control: every seat still in the room reads state as before.
  assert.equal(
    store.getStateOp({ playerId: 'h1', reconnectTokenHash: 'reconnect-hash-h1', nowMs: T0 + 1000 }).ok,
    true,
  );
  assert.equal(
    store.getStateOp({ playerId: 'hu1', reconnectTokenHash: 'reconnect-hash-hu1', nowMs: T0 + 1000 }).ok,
    true,
  );
});

test('v31 FIX ROUND (F3): a removed-while-away seat cannot rejoin — ticket register, ticket redeem, WS message, hello resume all refuse', async () => {
  const store = makeStore();
  // A ticket minted BEFORE the removal (the discarded tab's tab session
  // is gone, but the ticket record is what a returning tab would redeem).
  const minted = store.registerTicket({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    ticketId: 'ticket-f3-r1',
    ticketHash: 'ticket-hash-f3-r1',
    purpose: 'connect',
    expiresAtMs: T0 + 68_000,
    nowMs: T0,
  });
  assert.equal(minted.ok, true, `pre-removal ticket mint must succeed: ${minted.ok ? '' : minted.error}`);

  store.removePlayer({
    playerId: 'h1',
    hostTokenHash: 'host-hash',
    targetPlayerId: 'r1',
    nowMs: T0 + 1000,
  });

  // No fresh ticket after removal.
  const remint = store.registerTicket({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    ticketId: 'ticket-f3-r1b',
    ticketHash: 'ticket-hash-f3-r1b',
    purpose: 'connect',
    expiresAtMs: T0 + 68_000,
    nowMs: T0 + 2000,
  });
  assert.equal(remint.ok, false);
  assert.equal(remint.status, 409);

  // The pre-removal ticket cannot open a socket anymore.
  const redeemed = store.redeemTicketForConnect('ticket-hash-f3-r1', T0 + 2100);
  assert.equal(redeemed.ok, false);
  assert.equal(redeemed.code, 'FORBIDDEN');

  // A WS message from the seat (if a socket somehow survived) closes 4403.
  const msg = await store.handleWsMessage(
    { playerId: 'r1', sessionId: 's1' },
    { type: 'snapshot.request', commandId: 'snap-r1-1', payload: {} },
    T0 + 2200,
  );
  assert.equal(msg.close?.code, 4403, 'a left seat has no socket business left');

  // Hello resume is a no-op: a left seat is `disconnected`, never
  // `suspended`, and resumeSuspendedPlayer only touches suspended seats.
  const resumed = store.resumeOnHello('r1', T0 + 2300);
  assert.equal(resumed.resumed, false);
  assert.equal(store.player('r1').connectionState, 'disconnected');
});

test('v31 FIX ROUND (F3): a refused seat restores by name + token and reads state again', async () => {
  const store = makeStore();
  store.removePlayer({
    playerId: 'h1',
    hostTokenHash: 'host-hash',
    targetPlayerId: 'r1',
    nowMs: T0,
  });
  const refused = store.getStateOp({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 1000,
  });
  assert.equal(refused.ok, false);

  // The deliberate way back: rejoin by name with the saved token.
  const r = await store.addPlayerAsync({
    displayName: 'Runner 1',
    roomCode: 'ABCDEF',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 2000,
  });
  assert.equal(r.ok, true, `restore must succeed: ${r.ok ? '' : r.error}`);
  assert.equal(r.value.restored, true);
  assert.equal(store.player('r1').leftAt, null, 'the restore clears leftAt');

  const state = store.getStateOp({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 3000,
  });
  assert.equal(state.ok, true, 'a restored seat reads state again');
});

test('v31 FIX ROUND (F3): a mid-game leaver still reads results — the refusal is state-only, not verifyReconnect', () => {
  const store = makeStore();
  start(store);
  store.leaveSeat('r1', null, T0 + 5000);
  assert.notEqual(store.player('r1').leftAt, null, 'the leave stamps leftAt');

  const state = store.getStateOp({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 6000,
  });
  assert.equal(state.ok, false);
  assert.equal(state.status, 403);
  assert.equal(state.code, 'SEAT_REMOVED');

  // Natural completion (NOT host-cancel: `cancelMatch` deletes the
  // room, so a cancelled room has no results to read at all).
  const done = store.completeMatch(
    {
      outcome: 'runners-win',
      durationSeconds: 7,
      caughtRunnerIds: [],
      survivingRunnerIds: ['r1'],
      tags: [],
    },
    T0 + 7000,
  );
  assert.equal(done.ok, true, 'natural completion must succeed');

  // resultsFor uses verifyReconnect only — no leftAt check — so the
  // leaver's scores are still served. This is why the refusal lives
  // in getStateOp and not in the shared verifier.
  const results = store.resultsFor({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 8000,
  });
  assert.equal(results.ok, true, `a leaver must still read results: ${results.ok ? '' : results.error}`);
  assert.equal(results.value.scores['r1'] !== undefined, true, 'the leaver has a score');
});

test('v31 FIX ROUND (F3): issueHostToken refuses a host who left with no successor', async () => {
  const store = makeStore({ hunters: [], runners: [] });
  const minted = await store.issueHostToken({
    playerId: 'h1',
    reconnectTokenHash: 'reconnect-hash-h1',
    nowMs: T0,
  });
  assert.equal(minted.ok, true, 'a live host mints a token');

  store.leaveSeat('h1', null, T0 + 1000);
  assert.notEqual(store.player('h1').leftAt, null, 'the leave stamps leftAt');
  assert.equal(
    store.player('h1').isHost,
    true,
    'no successor, so leaveSeat keeps the isHost flag (only the token record is deleted)',
  );

  const again = await store.issueHostToken({
    playerId: 'h1',
    reconnectTokenHash: 'reconnect-hash-h1',
    nowMs: T0 + 2000,
  });
  assert.equal(again.ok, false, 'a left host must not mint');
  assert.equal(again.status, 403);
  assert.match(again.error, /left the room/);
});

// ---------------------------------------------------------------------------
// Zara (c) — DO-side revoke rate limit
// ---------------------------------------------------------------------------

test('v31 FIX ROUND (Zara (c)): revoke is rate-limited in the DO at 10/min/seat, per seat, and a 429 mutates nothing', () => {
  const store = makeStore();
  const minted = store.registerTicket({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    ticketId: 'ticket-revoke-limit-1',
    ticketHash: 'ticket-hash-revoke-limit-1',
    purpose: 'connect',
    expiresAtMs: T0 + 68_000,
    nowMs: T0,
  });
  assert.equal(minted.ok, true);

  // 10 revokes inside the minute: all allowed (the first revokes the
  // ticket, the rest revoke nothing — the bucket counts CALLS, because
  // the class saves after every successful revoke either way).
  for (let i = 0; i < 10; i += 1) {
    const r = store.revokeTickets({
      playerId: 'r1',
      reconnectTokenHash: 'reconnect-hash-r1',
      nowMs: T0 + i * 100,
    });
    assert.equal(r.ok, true, `revoke ${i + 1} of 10 must be allowed`);
  }
  assert.equal(
    store.mem.tickets.some((t) => t.ticketId === 'ticket-revoke-limit-1'),
    false,
    'the first revoke removed the ticket',
  );

  // 11th inside the minute: 429 with a retry-after.
  const limited = store.revokeTickets({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 1000,
  });
  assert.equal(limited.ok, false);
  assert.equal(limited.status, 429);
  assert.equal(limited.code, 'RATE_LIMITED');
  assert.equal(typeof limited.retryAfterSeconds, 'number');
  assert.ok((limited.retryAfterSeconds ?? 0) > 0);

  // Another seat has its own bucket.
  const other = store.revokeTickets({
    playerId: 'hu1',
    reconnectTokenHash: 'reconnect-hash-hu1',
    nowMs: T0 + 1100,
  });
  assert.equal(other.ok, true, 'the limit is per seat, not per room');

  // A 429 revoke mutates nothing: register a ticket, hit the limit
  // again, and the ticket must still be there.
  store.registerTicket({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    ticketId: 'ticket-revoke-limit-2',
    ticketHash: 'ticket-hash-revoke-limit-2',
    purpose: 'connect',
    expiresAtMs: T0 + 68_000,
    nowMs: T0 + 1200,
  });
  const limitedAgain = store.revokeTickets({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 1300,
  });
  assert.equal(limitedAgain.ok, false);
  assert.equal(limitedAgain.status, 429);
  assert.equal(
    store.mem.tickets.some((t) => t.ticketId === 'ticket-revoke-limit-2'),
    true,
    'a rate-limited revoke must not remove the ticket',
  );

  // After the window passes, revoke works again.
  const afterWindow = store.revokeTickets({
    playerId: 'r1',
    reconnectTokenHash: 'reconnect-hash-r1',
    nowMs: T0 + 61_000,
  });
  assert.equal(afterWindow.ok, true);
  assert.equal(afterWindow.value.revoked, 1);
});

// ---------------------------------------------------------------------------
// F6 (documented, UNFIXED) — the ping-pong mechanism
// ---------------------------------------------------------------------------

test('v31 FIX ROUND (F6, documented): a second mint invalidates the first tab token — the ping-pong, left unfixed this round', async () => {
  const store = makeStore();
  // Tab A (restored host seat) mints and caches its token.
  const first = await store.issueHostToken({
    playerId: 'h1',
    reconnectTokenHash: 'reconnect-hash-h1',
    nowMs: T0,
  });
  assert.equal(first.ok, true);
  // Tab B (same seat, its own sessionStorage copy) mints.
  const second = await store.issueHostToken({
    playerId: 'h1',
    reconnectTokenHash: 'reconnect-hash-h1',
    nowMs: T0 + 1000,
  });
  assert.equal(second.ok, true);
  assert.notEqual(
    first.value.hostToken,
    second.value.hostToken,
    'each mint is a fresh random token',
  );

  // Tab A's token is now dead: the overwrite killed it. Tab A's next
  // host action 403s, postHost re-mints once, and that mint kills
  // tab B's token in turn. This test documents the mechanism — the
  // fix (previous-hash grace or client-side coordination) must change
  // this assertion to "the first token still verifies".
  const firstHash = await hashHostToken(first.value.hostToken);
  assert.equal(
    store.verifyHost('h1', firstHash),
    null,
    'the first tab token dies on the second mint (F6, unfixed)',
  );
  const secondHash = await hashHostToken(second.value.hostToken);
  assert.notEqual(store.verifyHost('h1', secondHash), null, 'the newest token verifies');
});
