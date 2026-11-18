import test from 'node:test';
import assert from 'node:assert/strict';
import { route, joinAllowed, newTicket, handleWsUpgrade, createTicketStore, createAllowed, ticketAllowed, ticketRevokeAllowed, startAllowed } from '../src/http.js';
import { issueWsTicket, verifyWsTicket, WsTicketStore } from '../src/auth.js';
import {
  recoverState, snapshotForRecovery, snapshotForPlayer, addPlayer,
  buildWsSnapshot, snapshotLeakKeys,
  validateHello, closeCodeFor, handleWsClientMessage, newWsSession,
  noteMissedHeartbeat, alarmTick, startMatch,
  verifyReconnectToken, registerWsTicket,
  checkWsRate, completeMatch, purgeStaleFixes, ticketRenewalDue, FIX_TTL_MS,
} from '../src/room-do.js';
import type { RoomDoState } from '../src/room-do.js';
import { sha256Hex } from '@pakdam/shared';
import { parsePerMinuteLimit } from '../src/rate-limit.js';
import type { LocationFix, Ping, Player, Room } from '@pakdam/shared';
test('worker routing + rate limit placeholder', () => {
  assert.equal(route('/v1/rooms'), 'create-room');
  assert.equal(route('/v1/rooms/x/ws-ticket'), 'ws-ticket');
  assert.equal(route('/v1/rooms/x/ws-ticket/revoke'), 'ws-ticket-revoke');
  assert.equal(route('/v1/rooms/x/ticket'), 'ws-ticket'); // legacy alias
  assert.equal(route('/v1/rooms/x/ws'), 'websocket');
  assert.equal(route('/v1/rooms/x/join'), 'join');
  assert.equal(route('/v1/rooms/x/start'), 'start'); // QA BE-11: host start route
  assert.equal(route('/v1/rooms/x'), 'get-state');
  assert.equal(route('/nope'), 'not-found');
  assert.equal(joinAllowed('a', 1000), true);
});
test('rate limit env override: parsePerMinuteLimit falls back to 5 unless a positive integer is set; joinAllowed honours the override', () => {
  assert.equal(parsePerMinuteLimit(undefined, 5), 5);
  assert.equal(parsePerMinuteLimit('100', 5), 100);
  assert.equal(parsePerMinuteLimit('0', 5), 5, 'zero never disables the limit');
  assert.equal(parsePerMinuteLimit('-3', 5), 5);
  assert.equal(parsePerMinuteLimit('abc', 5), 5);
  assert.equal(parsePerMinuteLimit('2.5', 5), 5);
  // Default: 5 joins/min/IP, the 6th is refused.
  for (let i = 0; i < 5; i++) assert.equal(joinAllowed('env-default', 1000), true);
  assert.equal(joinAllowed('env-default', 1000), false);
  // Override: 100/min/IP, 16 joins pass (the local k6 case).
  for (let i = 0; i < 16; i++) assert.equal(joinAllowed('env-override', 1000, 100), true);
});
test('WS ticket: single-use short-lived, wrong ticket rejected, expired rejected', () => {
  const t = issueWsTicket('r1', 'p1', 60_000, 1000);
  assert.equal(verifyWsTicket(t, t.ticket, 2000), true);
  assert.equal(verifyWsTicket(t, 'wrong', 2000), false);
  assert.equal(verifyWsTicket(t, t.ticket, 1000 + 61_000), false);
  assert.equal(typeof newTicket('r1', 'p1'), 'string');
});
test('DO recovery: snapshot carries no coordinates and no pending pings', () => {
  const saved = { room: { roomId: 'r1', roomCode: 'ABC123', hostPlayerId: 'h1', phase: 'ACTIVE' as const, version: 3, config: {} as never, createdAt: new Date().toISOString(), startedAt: null, endsAt: null, pausedAt: null, result: null }, players: [], catches: [], activeCatchIds: [], serverSeq: 9, paused: false, pausedBy: null, sosActive: false, eventLog: [], gameEventLog: [] };
  const recovered = recoverState(saved);
  assert.deepEqual(recovered.latestFix, {});
  assert.deepEqual(recovered.pendingPings, []);
  assert.ok(!('latestFix' in snapshotForRecovery({ ...recovered, latestFix: { p1: {} as never } })));
});

// --- WS protocol (17 §3, v2.1 FROZEN) ---

const mkRoom = (): Room => ({
  roomId: 'r1', roomCode: 'ABC123', hostPlayerId: 'h1', phase: 'ACTIVE',
  version: 3, config: {} as never, createdAt: new Date().toISOString(),
  startedAt: null, endsAt: null, pausedAt: null, result: null,
});
const mkPlayer = (id: string, isHost = false): Player => ({
  playerId: id, roomId: 'r1', kind: isHost ? 'host-account' : 'guest', displayName: id,
  isHost, matchRole: isHost ? 'hunter' : 'runner', team: isHost ? 'hunters' : 'runners',
  // Real hash of a known token (`reconnect-${id}`) — restore tests
  // present the matching raw token (SEC-06, Worker 5).
  reconnectTokenHash: sha256Hex(`reconnect-${id}`), joinedAt: new Date().toISOString(),
  leftAt: null, connectionState: 'connected', lastFixAt: null,
  locationQuality: 'unknown', isReady: true, briefingConfirmed: true,
  ageGatePassed: true, suspensionCount: 0, ejectedAt: null,
});
const mkFix = (playerId: string, atMs = 5000): LocationFix => ({
  playerId, roomId: 'r1', lat: 23.35, lng: 85.32, accuracyMeters: 8,
  capturedAt: new Date(atMs).toISOString(), receivedAt: new Date(atMs).toISOString(), quality: 'good',
});
const mkPing = (): Ping => ({
  pingId: 'ping1', roomId: 'r1', subjectPlayerId: 'r1', recipientRole: 'hunters',
  uncertainty: { centre: { lat: 23.35, lng: 85.32 }, radiusMeters: 50 },
  ageSeconds: 0, qualityAtPing: 'good', createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const mkState = (): RoomDoState => ({
  room: mkRoom(), players: [mkPlayer('h1', true), mkPlayer('r1')],
  // Stored previous fix is deliberately OLDER (4000 ms) than any fix the
  // tests send (5000 ms+): validateFix rejects a fix identical to the
  // previous one as a duplicate, so the stored fix must differ in time.
  latestFix: { r1: mkFix('r1', 4000) }, outsideSinceMs: {}, outsideAccumMs: {},
  lastZoneBoundary: null, gameEventLog: [], pendingPings: [mkPing()],
  catches: [], activeCatchIds: [], serverSeq: 9, paused: false,
  pausedBy: null, sosActive: false, eventLog: [], idempotency: [],
  hostTokens: {}, lastPingAtMs: {}, wsTickets: [], wsRate: {},
});

test('WS ticket: single-use — second use is TICKET_REUSED, wrong seat is TICKET_INVALID, expired is TICKET_EXPIRED', () => {
  const store = new WsTicketStore();
  const issued = store.issue('r1', 'p1', 'connect', 60_000, 1000);
  assert.equal(store.redeem(issued.ticket, 'r1', 'p1', 2000).ok, true);
  assert.deepEqual(store.redeem(issued.ticket, 'r1', 'p1', 2000), { ok: false, code: 'TICKET_REUSED' });
  assert.deepEqual(store.redeem(issued.ticket, 'r1', 'p2', 2000), { ok: false, code: 'TICKET_INVALID' });
  assert.deepEqual(store.redeem(issued.ticket, 'r2', 'p1', 2000), { ok: false, code: 'TICKET_INVALID' });
  assert.deepEqual(store.redeem('not-a-ticket', 'r1', 'p1', 2000), { ok: false, code: 'TICKET_INVALID' });
  const short = store.issue('r1', 'p1', 'connect', 1000, 1000);
  assert.deepEqual(store.redeem(short.ticket, 'r1', 'p1', 5000), { ok: false, code: 'TICKET_EXPIRED' });
});

test('WS ticket: issuing a new ticket invalidates the earlier unredeemed ticket for the same seat', () => {
  const store = new WsTicketStore();
  const first = store.issue('r1', 'p1', 'connect', 60_000, 1000);
  const second = store.issue('r1', 'p1', 'renew', 60_000, 2000);
  assert.deepEqual(store.redeem(first.ticket, 'r1', 'p1', 3000), { ok: false, code: 'TICKET_INVALID' });
  const ok = store.redeem(second.ticket, 'r1', 'p1', 3000);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.purpose, 'renew');
  assert.equal(store.revokeSeat('r1', 'p1'), 0); // nothing unredeemed left
  const third = store.issue('r1', 'p1', 'connect', 60_000, 4000);
  assert.equal(store.revokeSeat('r1', 'p1'), 1);
  assert.deepEqual(store.redeem(third.ticket, 'r1', 'p1', 5000), { ok: false, code: 'TICKET_INVALID' });
});

test('WS upgrade: consumes the ticket; second handshake with the same ticket fails 4401 TICKET_REUSED', () => {
  const store = createTicketStore();
  const issued = store.issue('r1', 'p1', 'connect', 60_000, 1000);
  const first = handleWsUpgrade(store, issued.ticket, 'r1', 'p1', 2000);
  assert.equal(first.ok, true);
  const second = handleWsUpgrade(store, issued.ticket, 'r1', 'p1', 2000);
  assert.deepEqual(second, {
    ok: false, code: 'TICKET_REUSED', closeCode: 4401,
    message: 'WS ticket already redeemed — request a fresh ticket',
  });
  assert.deepEqual(handleWsUpgrade(store, null, 'r1', 'p1', 2000).ok, false);
});

test('hello: credential-bearing hello is rejected; valid hello passes; wrong protocol version is PROTOCOL_UNSUPPORTED', () => {
  const base = (payload: Record<string, unknown>) => ({
    v: 1, type: 'hello', roomId: 'r1', playerId: 'p1', clientSeq: 1, clientTs: 1000, payload,
  });
  const good = { protocolVersion: 1, clientVersion: 'pakdam-web/0.1.0', lastServerSeq: 0 };
  assert.deepEqual(validateHello(base(good)), { ok: true, lastServerSeq: 0, clientVersion: 'pakdam-web/0.1.0' });
  for (const cred of [{ ...good, ticket: 'abc' }, { ...good, token: 'abc' }, { ...good, password: 'abc' }]) {
    const r = validateHello(base(cred));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'VALIDATION_FAILED');
  }
  const topLevel = validateHello({ ...base(good), ticket: 'abc' });
  assert.equal(topLevel.ok, false);
  if (!topLevel.ok) assert.equal(topLevel.code, 'VALIDATION_FAILED');
  const wrongVersion = validateHello(base({ ...good, protocolVersion: 2 }));
  assert.equal(wrongVersion.ok, false);
  if (!wrongVersion.ok) assert.equal(wrongVersion.code, 'PROTOCOL_UNSUPPORTED');
  const missing = validateHello(base({ protocolVersion: 1 }));
  assert.equal(missing.ok, false);
});

test('snapshot: contains no coordinates, no pending pings, no token hashes; locationStatus known only with a held fix', () => {
  const snap = buildWsSnapshot(mkState(), 'h1', 5000);
  assert.equal(snap.type, 'snapshot');
  assert.deepEqual(snapshotLeakKeys(snap), []);
  const json = JSON.stringify(snap);
  assert.ok(!json.includes('"lat"') && !json.includes('"lng"'));
  assert.ok(!json.includes(sha256Hex('reconnect-r1')) && !json.includes(sha256Hex('reconnect-h1')), 'no token hashes');
  if (snap.type === 'snapshot') {
    assert.equal(snap.payload.serverSeq, 9);
    // r1 has a held fix -> known; h1 has none -> unknown.
    assert.equal(snap.payload.locationStatus['r1'], 'known');
    assert.equal(snap.payload.locationStatus['h1'], 'unknown');
    assert.deepEqual(snap.payload.activeCatches, []);
    assert.ok(!('pendingPings' in snap.payload) && !('latestFix' in snap.payload));
  }
  // After a recovery every player is 'unknown' until a fresh fix arrives.
  const recovered = buildWsSnapshot(recoverState({ ...mkState(), serverSeq: 9 }), 'h1', 5000);
  assert.deepEqual(snapshotLeakKeys(recovered), []);
  if (recovered.type === 'snapshot') {
    assert.equal(recovered.payload.locationStatus['r1'], 'unknown');
    assert.equal(recovered.payload.locationStatus['h1'], 'unknown');
  }
});

test('reconnect: snapshot.request / resync.request return a fresh snapshot with serverSeq; unknown types are VALIDATION_FAILED', () => {
  const state = mkState();
  for (const type of ['snapshot.request', 'resync.request']) {
    const res = handleWsClientMessage(state, 'r1', {
      v: 1, type, roomId: 'r1', playerId: 'r1', clientSeq: 1, clientTs: 1000,
      payload: { lastServerSeq: 4 },
    }, 5000);
    assert.equal(res.replies.length, 1);
    assert.equal(res.replies[0]?.type, 'snapshot');
    if (res.replies[0]?.type === 'snapshot') assert.equal(res.replies[0].payload.serverSeq, 9);
    assert.deepEqual(snapshotLeakKeys(res.replies[0]!), []);
  }
  const bad = handleWsClientMessage(state, 'r1', {
    v: 1, type: 'teleport', roomId: 'r1', playerId: 'r1', clientSeq: 2, clientTs: 1000, payload: {},
  }, 5000);
  assert.equal(bad.replies[0]?.type, 'error');
  if (bad.replies[0]?.type === 'error') assert.equal(bad.replies[0].payload.code, 'VALIDATION_FAILED');
});

test('WS messages: heartbeat gets heartbeat.ack; auth.refresh surfaces the ticket for store validation; suspension broadcasts', () => {
  const state = mkState();
  const hb = handleWsClientMessage(state, 'r1', {
    v: 1, type: 'heartbeat', roomId: 'r1', playerId: 'r1', clientSeq: 1, clientTs: 1000, payload: {},
  }, 5000);
  assert.equal(hb.replies[0]?.type, 'heartbeat.ack');
  assert.equal(hb.heartbeatReceived, true);
  // SEC-11: an unregistered ticket no longer "refreshes" anything —
  // the DO validates it against its registered records and fails the
  // renewal. (The registered-ticket success path is covered by the
  // SEC-11 tests below.)
  const refresh = handleWsClientMessage(state, 'r1', {
    v: 1, type: 'auth.refresh', roomId: 'r1', playerId: 'r1', clientSeq: 2, clientTs: 1000,
    payload: { ticket: 'new-ticket-value' },
  }, 5000);
  assert.equal(refresh.authRefreshFailed?.code, 'TICKET_INVALID');
  assert.equal(refresh.authRefreshed, undefined);
  const susp = handleWsClientMessage(state, 'r1', {
    v: 1, type: 'player.suspended', roomId: 'r1', playerId: 'r1', clientSeq: 3, clientTs: 1000,
    payload: { reason: 'tab-hidden' },
  }, 5000);
  assert.equal(susp.replies[0]?.type, 'player.suspended');
  if (susp.replies[0]?.type === 'player.suspended') assert.equal(susp.replies[0].payload.reason, 'tab-hidden');
  assert.equal(susp.state.players.find((p) => p.playerId === 'r1')?.connectionState, 'suspended');
});

test('close-code mapping (17 §3.4)', () => {
  assert.deepEqual(closeCodeFor('normal'), { code: 1000, action: 'do-not-reconnect' });
  assert.deepEqual(closeCodeFor('going-away'), { code: 1001, action: 'reconnect-with-backoff' });
  assert.deepEqual(closeCodeFor('abnormal'), { code: 1006, action: 'reconnect-with-backoff' });
  assert.deepEqual(closeCodeFor('bad-request'), { code: 4400, action: 'fresh-ticket-then-reconnect-once' });
  assert.deepEqual(closeCodeFor('ticket'), { code: 4401, action: 'fresh-ticket-then-reconnect-once' });
  assert.deepEqual(closeCodeFor('forbidden'), { code: 4403, action: 'do-not-reconnect' });
  assert.deepEqual(closeCodeFor('protocol'), { code: 4409, action: 'upgrade-no-retry' });
  assert.deepEqual(closeCodeFor('rate-limited'), { code: 4413, action: 'backoff-until-retry-after' });
  assert.deepEqual(closeCodeFor('server-error'), { code: 1011, action: 'reconnect-with-backoff' });
});

test('WS session: missed-heartbeat counter trips only at the (OPEN) limit', () => {
  let session = newWsSession('r1', 'p1', 'tid-1', 9);
  assert.equal(noteMissedHeartbeat(session, null).exceeded, false); // OPEN limit: never trips without a value
  const step1 = noteMissedHeartbeat(session, 3);
  assert.equal(step1.exceeded, false);
  session = step1.session;
  const step2 = noteMissedHeartbeat(session, 3);
  assert.equal(step2.exceeded, false);
  assert.equal(noteMissedHeartbeat(step2.session, 3).exceeded, true);
});

// --- HIGH-1 / HIGH-2 (fix round): DO game-command handlers + idempotency ---

const send = (state: RoomDoState, playerId: string, type: string, payload: Record<string, unknown>, commandId: string | null, nowMs = 5000) =>
  handleWsClientMessage(state, playerId, {
    v: 1, type, roomId: 'r1', playerId, clientSeq: 1, clientTs: nowMs,
    ...(commandId ? { commandId } : {}), payload,
  }, nowMs);
const errCode = (res: { replies: { type: string }[] }): string | null => {
  const e = res.replies.find((r) => r.type === 'error') as { payload?: { code?: string } } | undefined;
  return e?.payload?.code ?? null;
};

test('WS wiring: handleWsClientMessage rejects malformed payloads via validateWsClientMessage (VALIDATION_FAILED, no state change)', () => {
  const state = mkState();
  // location.update with the fix at top level (not under payload) — the DO never reads it.
  const topLevel = handleWsClientMessage(state, 'r1', {
    v: 1, type: 'location.update', roomId: 'r1', playerId: 'r1', clientSeq: 1, clientTs: 1000,
    commandId: 'w-1', fix: mkFix('r1'),
  }, 5000);
  assert.equal(errCode(topLevel), 'VALIDATION_FAILED');
  assert.deepEqual(topLevel.state.latestFix, state.latestFix);
  // location.update with latitude out of range.
  const badLat = handleWsClientMessage(state, 'r1', {
    v: 1, type: 'location.update', roomId: 'r1', playerId: 'r1', clientSeq: 1, clientTs: 1000,
    commandId: 'w-2', payload: { fix: { ...mkFix('r1'), lat: 91 } },
  }, 5000);
  assert.equal(errCode(badLat), 'VALIDATION_FAILED');
  assert.deepEqual(badLat.state.latestFix, state.latestFix);
  // safety.pause without the required reason key (client always sends reason: string | null).
  const noReason = handleWsClientMessage(state, 'h1', {
    v: 1, type: 'safety.pause', roomId: 'r1', playerId: 'h1', clientSeq: 1, clientTs: 1000,
    commandId: 'w-3', payload: {},
  }, 5000);
  assert.equal(errCode(noReason), 'VALIDATION_FAILED');
  assert.equal(noReason.state.room.phase, 'ACTIVE');
  // A valid message still flows through unchanged.
  const good = handleWsClientMessage(state, 'r1', {
    v: 1, type: 'location.update', roomId: 'r1', playerId: 'r1', clientSeq: 1, clientTs: 1000,
    commandId: 'w-4', payload: { fix: mkFix('r1') },
  }, 5000);
  assert.equal(errCode(good), null);
  assert.equal(good.replies[0]?.type, 'player.visibility');
});

test('HIGH-1: full catch runs over the DO handler — request, confirm with the issued token, confirmed once', () => {
  let state = mkState();
  const req = send(state, 'h1', 'catch.request', { runnerId: 'r1' }, 'cmd-req-1');
  assert.equal(errCode(req), null);
  assert.equal(req.replies[0]?.type, 'catch.requested');
  assert.ok(req.issuedCatchToken, 'raw token must be returned to the runner only');
  assert.equal(req.issuedCatchToken?.runnerPlayerId, 'r1');
  const catchId = req.issuedCatchToken!.catchId;
  // No token or hash in any broadcast reply.
  assert.ok(!JSON.stringify(req.replies).includes(req.issuedCatchToken!.token));
  assert.ok(!JSON.stringify(req.replies).includes('qrTokenHash'));
  assert.equal(req.state.catches.length, 1);
  assert.equal(req.state.catches[0]?.state, 'requested');
  assert.equal(req.state.serverSeq, 10);
  state = req.state;
  // Runner confirms with the issued token.
  const conf = send(state, 'r1', 'catch.confirm', { catchId, qrToken: req.issuedCatchToken!.token }, 'cmd-conf-1');
  assert.equal(errCode(conf), null);
  assert.equal(conf.replies[0]?.type, 'catch.confirmed');
  assert.equal(conf.state.catches[0]?.state, 'confirmed');
  assert.deepEqual(conf.state.activeCatchIds, []);
  // QA GL-02 (2026-11-17): catching the last Runner completes the match
  // at once (RESOLVING -> COMPLETED is two more serverSeq steps: 11
  // for the confirm, 12 for RESOLVING, 13 for COMPLETED). The old
  // expectation of 11 encoded the bug (match ran to the clock).
  assert.equal(conf.state.serverSeq, 13);
  assert.equal(conf.state.room.phase, 'COMPLETED');
  assert.equal(conf.state.room.result?.outcome, 'hunters-win');
  assert.equal(conf.replies.some((r) => r.type === 'match.completed'), true);
});

test('HIGH-2: duplicate commandId returns the original outcome with replayed:true and no second effect', () => {
  const state = mkState();
  const first = send(state, 'h1', 'catch.request', { runnerId: 'r1' }, 'cmd-dup-1');
  assert.equal(first.replayed, false);
  const seqAfterFirst = first.state.serverSeq;
  assert.equal(first.state.catches.length, 1);
  const dup = send(first.state, 'h1', 'catch.request', { runnerId: 'r1' }, 'cmd-dup-1');
  assert.equal(dup.replayed, true);
  assert.equal(dup.state.serverSeq, seqAfterFirst, 'duplicate must not advance serverSeq');
  assert.equal(dup.state.catches.length, 1, 'duplicate must not create a second catch');
  assert.deepEqual(dup.replies, first.replies, 'duplicate returns the identical replies');
  assert.equal(dup.issuedCatchToken?.token, first.issuedCatchToken?.token);
  // Same commandId for a DIFFERENT command is rejected.
  const wrong = send(first.state, 'h1', 'safety.pause', { reason: null }, 'cmd-dup-1');
  assert.equal(errCode(wrong), 'VALIDATION_FAILED');
  assert.equal(wrong.state.catches.length, 1);
  // Missing commandId on a mutating command is rejected.
  const noId = send(first.state, 'h1', 'catch.request', { runnerId: 'r1' }, null);
  assert.equal(errCode(noId), 'VALIDATION_FAILED');
});

test('HIGH-1: catch dispute, wrong token, expiry, and suspended-runner rejection', () => {
  let state = mkState();
  const req = send(state, 'h1', 'catch.request', { runnerId: 'r1' }, 'cmd-d-1');
  const catchId = req.issuedCatchToken!.catchId;
  state = req.state;
  // Wrong token is rejected and the catch stays requested.
  const wrong = send(state, 'r1', 'catch.confirm', { catchId, qrToken: 'WRONGCODE123' }, 'cmd-d-2');
  assert.equal(errCode(wrong), 'VALIDATION_FAILED');
  assert.equal(wrong.state.catches[0]?.state, 'requested');
  // Runner disputes instead.
  const disp = send(state, 'r1', 'catch.dispute', { catchId, reason: 'not touched' }, 'cmd-d-3');
  assert.equal(disp.replies[0]?.type, 'catch.disputed');
  assert.equal(disp.state.catches[0]?.state, 'disputed');
  assert.equal(disp.state.catches[0]?.resolution, 'neutral-review-required');
  // A second request after the dispute, then expiry by the clock.
  const req2 = send(disp.state, 'h1', 'catch.request', { runnerId: 'r1' }, 'cmd-d-4');
  const catchId2 = req2.issuedCatchToken!.catchId;
  const expired = send(req2.state, 'r1', 'catch.confirm', { catchId: catchId2, qrToken: req2.issuedCatchToken!.token }, 'cmd-d-5', 5000 + 121_000);
  assert.equal(expired.replies[0]?.type, 'catch.expired');
  assert.equal(expired.state.catches.find((c) => c.catchId === catchId2)?.state, 'expired');
  // Suspended Runner cannot be catch-requested.
  let s2 = mkState();
  const susp = send(s2, 'r1', 'player.suspended', { reason: 'screen-locked' }, 'cmd-d-6');
  assert.equal(susp.replies[0]?.type, 'player.suspended');
  s2 = susp.state;
  const blocked = send(s2, 'h1', 'catch.request', { runnerId: 'r1' }, 'cmd-d-7');
  assert.equal(errCode(blocked), 'INVALID_STATE');
  // Non-Hunter may not request a catch.
  assert.equal(errCode(send(mkState(), 'r1', 'catch.request', { runnerId: 'h1' }, 'cmd-d-8')), 'FORBIDDEN');
});

test('HIGH-1: location.update stores the fix server-side and replies visibility only — no coordinates leave the server', () => {
  const state = mkState();
  const fix = mkFix('r1');
  const res = send(state, 'r1', 'location.update', { fix }, 'cmd-loc-1');
  assert.equal(errCode(res), null);
  assert.equal(res.replies[0]?.type, 'player.visibility');
  assert.ok(!JSON.stringify(res.replies).includes('"lat"') && !JSON.stringify(res.replies).includes('23.35'));
  assert.deepEqual(res.state.latestFix['r1']?.lat, 23.35);
  assert.equal(res.state.players.find((p) => p.playerId === 'r1')?.locationQuality, 'good');
  // A fix for another seat is rejected.
  assert.equal(errCode(send(state, 'r1', 'location.update', { fix: mkFix('h1') }, 'cmd-loc-2')), 'VALIDATION_FAILED');
  // Duplicate location.update replays without re-applying.
  const dup = send(res.state, 'r1', 'location.update', { fix }, 'cmd-loc-1');
  assert.equal(dup.replayed, true);
  assert.equal(dup.state.serverSeq, res.state.serverSeq);
});

test('Zone-exit: location.update records first-seen-outside, never resets it while outside, clears it back inside', () => {
  // Square zone around the mkFix point (23.35, 85.32).
  const zone = { boundary: [
    { lat: 23.34, lng: 85.31 }, { lat: 23.34, lng: 85.33 },
    { lat: 23.36, lng: 85.33 }, { lat: 23.36, lng: 85.31 },
  ] };
  const zoned = { ...mkState(), room: { ...mkRoom(), config: { playZoneEnabled: true, zone } as never } };
  const outsideFix = { ...mkFix('r1'), lat: 23.40, lng: 85.32 };
  const first = send(zoned, 'r1', 'location.update', { fix: outsideFix }, 'cmd-zone-1', 5000);
  assert.equal(errCode(first), null);
  assert.equal(first.state.outsideSinceMs['r1'], 5000);
  assert.ok(first.state.eventLog.some((e) => e.type === 'zone.exit'));
  // A second outside fix 3 s later does NOT move first-seen-outside —
  // the 30-second countdown runs from the first sighting, not the latest.
  // (Fresh timestamp: a byte-identical retransmit is a duplicate and is
  // rejected by validateFix, so the second fix carries a new capturedAt.)
  const outsideFix2 = { ...mkFix('r1', 8000), lat: 23.40, lng: 85.32 };
  const second = send(first.state, 'r1', 'location.update', { fix: outsideFix2 }, 'cmd-zone-2', 8000);
  assert.equal(errCode(second), null);
  assert.equal(second.state.outsideSinceMs['r1'], 5000);
  assert.equal(second.state.eventLog.filter((e) => e.type === 'zone.exit').length, 1);
  // Back inside clears it.
  const inside = send(second.state, 'r1', 'location.update', { fix: mkFix('r1', 10000) }, 'cmd-zone-3', 10000);
  assert.equal(inside.state.outsideSinceMs['r1'], undefined);
  // No zone at all (mkState default config) never crashes and records nothing.
  const noZone = send(mkState(), 'r1', 'location.update', { fix: outsideFix }, 'cmd-zone-4', 5000);
  assert.equal(errCode(noZone), null);
  assert.deepEqual(noZone.state.outsideSinceMs, {});
});

test('HIGH-1: safety pause/resume, SOS, leave, ready, briefing, signal, pin, announcement', () => {
  let state = mkState();
  const pause = send(state, 'r1', 'safety.pause', { reason: 'need a break' }, 'cmd-s-1');
  assert.equal(pause.replies[0]?.type, 'safety.paused');
  assert.equal(pause.replies[1]?.type, 'room.state');
  if (pause.replies[1]?.type === 'room.state') assert.equal(pause.replies[1].payload.phase, 'SAFETY_PAUSED');
  assert.equal(pause.state.paused, true);
  assert.equal(pause.state.pausedBy, 'r1');
  state = pause.state;
  // Non-host cannot resume.
  assert.equal(errCode(send(state, 'r1', 'safety.resume', {}, 'cmd-s-2')), 'FORBIDDEN');
  const resume = send(state, 'h1', 'safety.resume', {}, 'cmd-s-3');
  assert.equal(resume.replies[0]?.type, 'safety.resumed');
  assert.equal(resume.state.paused, false);
  state = resume.state;
  const sos = send(state, 'r1', 'safety.sos', { reason: null }, 'cmd-s-4');
  assert.equal(sos.replies[0]?.type, 'sos.raised');
  assert.equal(sos.state.sosActive, true);
  state = sos.state;
  const sig = send(state, 'r1', 'signal.send', { code: ' regroup' }, 'cmd-s-5');
  assert.equal(sig.replies[0]?.type, 'signal');
  const pin = send(state, 'h1', 'pin.place', { point: { lat: 23.35, lng: 85.32 }, label: 'meet here' }, 'cmd-s-6');
  assert.equal(pin.replies[0]?.type, 'pin');
  assert.equal(errCode(send(state, 'r1', 'announcement.send', { text: 'hi' }, 'cmd-s-7')), 'FORBIDDEN');
  const ann = send(state, 'h1', 'announcement.send', { text: 'head start over' }, 'cmd-s-8');
  assert.equal(ann.replies[0]?.type, 'announcement');
  const ready = send(state, 'r1', 'ready.set', { isReady: false }, 'cmd-s-9');
  assert.equal(ready.state.players.find((p) => p.playerId === 'r1')?.isReady, false);
  const brief = send(state, 'r1', 'briefing.confirm', {}, 'cmd-s-10');
  assert.equal(brief.state.players.find((p) => p.playerId === 'r1')?.briefingConfirmed, true);
  const leave = send(state, 'r1', 'leave', { reason: null }, 'cmd-s-11');
  assert.equal(leave.replies[0]?.type, 'player.left');
  assert.ok(leave.state.players.find((p) => p.playerId === 'r1')?.leftAt);
});

test('HIGH-1: snapshot shows active catches only to their parties, with no token hash', () => {
  let state = mkState();
  // Add a second runner so party filtering can be observed.
  const r2 = mkPlayer('r2');
  state = { ...state, players: [...state.players, r2] };
  const req = send(state, 'h1', 'catch.request', { runnerId: 'r1' }, 'cmd-p-1');
  state = req.state;
  const hunterSnap = buildWsSnapshot(state, 'h1', 5000);
  const runnerSnap = buildWsSnapshot(state, 'r1', 5000);
  const otherSnap = buildWsSnapshot(state, 'r2', 5000);
  if (hunterSnap.type === 'snapshot' && runnerSnap.type === 'snapshot' && otherSnap.type === 'snapshot') {
    assert.equal(hunterSnap.payload.activeCatches.length, 1);
    assert.equal(runnerSnap.payload.activeCatches.length, 1);
    assert.equal(otherSnap.payload.activeCatches.length, 0, 'unrelated seats must not see the catch');
    assert.ok(!('qrTokenHash' in hunterSnap.payload.activeCatches[0]!));
    assert.deepEqual(snapshotLeakKeys(hunterSnap), []);
  } else assert.fail('snapshots expected');
  // Recovery expires the pending catch and strips its hash.
  const recovered = recoverState({ ...state, serverSeq: state.serverSeq });
  assert.equal(recovered.catches[0]?.state, 'expired');
  assert.equal(recovered.catches[0]?.qrTokenHash, null);
  assert.deepEqual(recovered.idempotency, []);
});

// --- SECURITY QA 2026-11-17 (SEC-01..SEC-07 regressions) ---

test('SEC-01: snapshotForPlayer strips reconnect-token hashes (get-state must never leak them)', () => {
  const snap = snapshotForPlayer(mkState(), 'r1');
  assert.ok(snap, 'member snapshot exists');
  assert.ok(!JSON.stringify(snap).includes(sha256Hex('reconnect-r1')) && !JSON.stringify(snap).includes(sha256Hex('reconnect-h1')));
  assert.ok(!('reconnectTokenHash' in (snap!.players[0] as Record<string, unknown>)));
});

test('SEC-02: snapshotForPlayer returns null for a playerId that is not a seat in the room (IDOR guard)', () => {
  assert.equal(snapshotForPlayer(mkState(), 'attacker-not-in-room'), null);
  assert.equal(snapshotForPlayer(mkState(), 'h1') !== null, true);
});

test('SEC-01b: WS snapshot with a REAL zone config carries no player coordinates and no hashes (zone boundary itself is shared by design)', () => {
  const zone = { boundary: [
    { lat: 23.34, lng: 85.31 }, { lat: 23.34, lng: 85.33 },
    { lat: 23.36, lng: 85.33 }, { lat: 23.36, lng: 85.31 },
  ], shrinkPhases: [] };
  const zoned = { ...mkState(), room: { ...mkRoom(), config: { playZoneEnabled: true, zone } as never } };
  const snap = buildWsSnapshot(zoned, 'h1', 5000);
  const json = JSON.stringify(snap);
  // Player fix coordinates (23.35 / 85.32) must not appear; the zone
  // boundary (23.34/23.36/85.31/85.33) is the shared play area and IS
  // in the snapshot by design — that is why snapshotLeakKeys flags
  // '"lat"' here and why the old test (config {}) passed vacuously.
  assert.ok(!json.includes('23.35') && !json.includes('85.32'), 'no player fix coordinates');
  assert.ok(!json.includes(sha256Hex('reconnect-r1')) && !json.includes(sha256Hex('reconnect-h1')), 'no token hashes');
  assert.ok(!json.includes('qrTokenHash') && !json.includes('pendingPings') && !json.includes('latestFix'));
});

test('SEC-03: a new joiner can never claim host powers — addPlayer always creates non-host seats', () => {
  const lobby = { ...mkState(), room: { ...mkRoom(), phase: 'LOBBY' as const } };
  const joined = addPlayer(lobby, 'Mallory', 'guest', 5000);
  assert.equal(joined.player.isHost, false);
  assert.equal(joined.restored, false);
});

test('SEC-04: addPlayer rejects blank and URL display names with a clean error (no uncaught Zod dump)', () => {
  const lobby = { ...mkState(), room: { ...mkRoom(), phase: 'LOBBY' as const } };
  assert.throws(() => addPlayer(lobby, '   ', 'guest', 5000), /VALIDATION_FAILED/);
  assert.throws(() => addPlayer(lobby, 'https://evil.example/x', 'guest', 5000), /VALIDATION_FAILED/);
  assert.throws(() => addPlayer(lobby, 'x'.repeat(31), 'guest', 5000), /VALIDATION_FAILED/);
});

test('SEC-05: a NEW join is refused once the match has started; restoring an existing seat still works', () => {
  const active = { ...mkState(), room: { ...mkRoom(), phase: 'ACTIVE' as const } };
  assert.throws(() => addPlayer(active, 'LateJoiner', 'guest', 5000), /INVALID_STATE/);
  // Restore is a resume, not a new join: the host rejoining by name in
  // an ACTIVE room still works (and keeps the host flag) — but ONLY
  // with the seat's reconnect token (SEC-06, Worker 5): a display
  // name alone never restores a seat any more.
  assert.throws(() => addPlayer(active, 'H1', 'guest', 5000), /reconnect token/i, 'no token, no restore');
  assert.throws(
    () => addPlayer(active, 'H1', 'guest', 5000, { reconnectToken: 'wrong-token' }),
    /reconnect token/i, 'a wrong token never restores the seat',
  );
  const restored = addPlayer(active, 'H1', 'guest', 5000, { reconnectToken: 'reconnect-h1' });
  assert.equal(restored.restored, true);
  assert.equal(restored.player.playerId, 'h1');
  assert.equal(restored.player.isHost, true);
});

test('SEC-07: location.update stores only the seven LocationFix fields — client junk fields are dropped', () => {
  const state = mkState();
  const fix = { ...mkFix('r1'), junk: 'x'.repeat(100000) } as unknown as LocationFix;
  const res = send(state, 'r1', 'location.update', { fix }, 'cmd-sec-7');
  assert.equal(errCode(res), null);
  const stored = res.state.latestFix['r1'] as unknown as Record<string, unknown>;
  assert.equal('junk' in stored, false);
  assert.deepEqual(Object.keys(stored).sort(), ['accuracyMeters', 'capturedAt', 'lat', 'lng', 'playerId', 'quality', 'receivedAt', 'roomId']);
});

// --- BACKEND QA 2026-11-17 (BE-07..BE-09 regressions) ---

test('BE-07: catch.request with catchConfirmationRequired=false does NOT count the tag at once — Runner confirmation is always required', () => {
  // The auto-confirm path was removed (simplification round,
  // 2026-11-18): runner confirmation is a fixed rule, not a switch.
  // Even a stored config with the flag off must leave the catch
  // pending until the Runner confirms it.
  const state = { ...mkState(), room: { ...mkRoom(), config: { catchConfirmationRequired: false } as never } };
  const res = send(state, 'h1', 'catch.request', { runnerId: 'r1' }, 'cmd-be07');
  assert.equal(errCode(res), null);
  assert.equal(res.replies.some((r) => r.type === 'catch.confirmed'), false);
  assert.equal(res.replies.some((r) => r.type === 'catch.requested'), true);
  assert.equal(res.state.catches[0]?.state, 'requested');
  assert.equal(res.state.gameEventLog.some((e) => (e as { type?: string }).type === 'PLAYER_TAGGED'), false);
  // The single Runner is only claimed, not caught: the match stays live.
  assert.equal(res.state.room.phase, 'ACTIVE');
  assert.equal(res.state.room.result, null);
});

test('BE-08: outside-zone countdown does not run in the LOBBY, and freezes across a safety pause', () => {
  const zone = { boundary: [
    { lat: 23.34, lng: 85.31 }, { lat: 23.34, lng: 85.33 },
    { lat: 23.36, lng: 85.33 }, { lat: 23.36, lng: 85.31 },
  ], shrinkPhases: [] };
  // LOBBY: an outside fix is stored, but no countdown starts — the
  // player must not be ejected seconds after the match starts.
  const lobby = { ...mkState(), room: { ...mkRoom(), phase: 'LOBBY' as const, config: { playZoneEnabled: true, zone } as never } };
  const outsideFix = { ...mkFix('r1'), lat: 23.40, lng: 85.32 };
  const lr = send(lobby, 'r1', 'location.update', { fix: outsideFix }, 'cmd-be08a', 5000);
  assert.equal(errCode(lr), null);
  assert.equal(lr.state.latestFix['r1']?.lat, 23.40);
  assert.equal(lr.state.outsideSinceMs['r1'], undefined);
  // ACTIVE, then a 30 s safety pause: the in-progress countdown must
  // shift by the pause, not span it (else instant ejection on resume).
  const active = { ...mkState(), room: { ...mkRoom(), config: { playZoneEnabled: true, zone } as never }, outsideSinceMs: { r1: 5000 } };
  const paused = send(active, 'h1', 'safety.pause', { reason: null }, 'cmd-be08b', 10000);
  assert.equal(paused.state.paused, true);
  const resumed = send(paused.state, 'h1', 'safety.resume', {}, 'cmd-be08c', 40000);
  assert.equal(resumed.state.paused, false);
  assert.equal(resumed.state.outsideSinceMs['r1'], 35000);
});

test('BE-09: restoring an ejected seat by display name keeps it ejected (never flips it to connected)', () => {
  const state = mkState();
  const ejected = {
    ...state,
    players: state.players.map((p) => (p.playerId === 'r1'
      ? { ...p, ejectedAt: new Date(1000).toISOString(), connectionState: 'disconnected' as const }
      : p)),
  };
  const restored = addPlayer(ejected, 'r1', 'guest', 5000, { reconnectToken: 'reconnect-r1' });
  assert.equal(restored.restored, true);
  assert.ok(restored.player.ejectedAt, 'ejection is never undone by rejoining');
  assert.equal(restored.player.connectionState, 'disconnected');
});

// --- PERF (QA 2026-11-17): alarmTick shrink detection ---------------
const perfBase = [
  { lat: 23.34, lng: 85.31 }, { lat: 23.34, lng: 85.33 },
  { lat: 23.36, lng: 85.33 }, { lat: 23.36, lng: 85.31 },
];
const perfShrunk = [
  { lat: 23.345, lng: 85.315 }, { lat: 23.345, lng: 85.325 },
  { lat: 23.355, lng: 85.325 }, { lat: 23.355, lng: 85.315 },
];
const mkZonedState = (startedAtIso: string, lastBoundary: typeof perfBase | null): RoomDoState => ({
  ...mkState(),
  // The stored fix (4000 ms) is stale at the Date.now() tick the PERF
  // tests use, and the SEC-13 purge would change the state object —
  // the shrink-detection identity check needs a fix-free state.
  latestFix: {},
  room: {
    ...mkRoom(),
    phase: 'ACTIVE' as const,
    startedAt: startedAtIso,
    endsAt: null,
    config: { playZoneEnabled: true, zone: { boundary: perfBase, shrinkPhases: [{ atSeconds: 300, boundary: perfShrunk }] } } as never,
  },
  lastZoneBoundary: lastBoundary,
});

test('PERF: alarmTick steady tick returns the same state object and no messages (no shrink, no ejection)', () => {
  const nowMs = Date.now();
  const state = mkZonedState(new Date(nowMs - 60_000).toISOString(), perfBase);
  const first = alarmTick(state, nowMs);
  assert.equal(first.messages.length, 0);
  assert.equal(first.state, state, 'steady tick must not copy state — webSocketMessage persists only on change');
  assert.equal(first.alarmDelayMs, 1000);
  const second = alarmTick(first.state, nowMs + 1000);
  assert.equal(second.messages.length, 0);
  assert.equal(second.state, state);
});

test('PERF: alarmTick still emits zone.update exactly once when a shrink fires, then goes quiet', () => {
  const nowMs = Date.now();
  // Started 301 s ago: the 300 s shrink phase is due, but lastZoneBoundary
  // still holds the base boundary, so this tick must emit the update.
  const state = mkZonedState(new Date(nowMs - 301_000).toISOString(), perfBase);
  const first = alarmTick(state, nowMs);
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0]?.type, 'zone.update');
  // Next-zone draw (2026-11-17): the DO re-draws the shrink POSITION
  // server-side at the tick — the emitted boundary is the drawn one,
  // NOT the stored concentric placeholder (perfShrunk). The stored
  // phase is replaced by the drawn boundary, so the next tick sees the
  // same ref and stays quiet. Only the SIZE follows the stored phase.
  assert.notDeepEqual(first.state.lastZoneBoundary, perfShrunk, 'shrink re-draws the next zone server-side; the stored phase boundary is a size placeholder only');
  assert.deepEqual(first.state.room.config.zone.shrinkPhases[0]?.boundary, first.state.lastZoneBoundary, 'stored phase replaced by the drawn boundary');
  const emittedZone = (first.messages[0] as unknown as { payload: { zone: { shrinkPhases: { boundary: unknown }[] } } }).payload.zone;
  assert.deepEqual(emittedZone.shrinkPhases[0]?.boundary, first.state.lastZoneBoundary, 'emitted zone carries the drawn boundary');
  const second = alarmTick(first.state, nowMs + 1000);
  assert.equal(second.messages.length, 0, 'no duplicate zone.update once the shrink is recorded');
  assert.equal(second.state, first.state);
});

test('PERF: alarmTick does NOT emit zone.update after recovery when no shrink fired (lastZoneBoundary null)', () => {
  // Worker 4 fix (2026-11-18, B-P3-01): the old assertion — emit once
  // after recovery — was the spurious zone.update defect itself. With
  // lastZoneBoundary null and no shrink due (room started 60 s ago,
  // first shrink at 300 s), the first tick seeds the baseline
  // SILENTLY: no zone.update, no ZONE_UPDATED event, no serverSeq
  // bump. A shrink that fired while hibernating still emits (the
  // sibling test above, phaseIndex > 0).
  const nowMs = Date.now();
  const state = mkZonedState(new Date(nowMs - 60_000).toISOString(), null);
  const first = alarmTick(state, nowMs);
  assert.equal(first.messages.length, 0, 'no spurious zone.update for an unchanged boundary');
  assert.deepEqual(first.state.lastZoneBoundary, perfBase, 'baseline seeded to the base boundary');
  const second = alarmTick(first.state, nowMs + 1000);
  assert.equal(second.messages.length, 0, 'still quiet once the baseline is seeded');
  assert.equal(second.state, first.state);
});

// --- GAME LOGIC (QA 2026-11-17, GL-01..GL-09): DO rule enforcement ----
// Each test pins a fix from the game-logic audit; the pre-fix behaviour
// is recorded in pakdam-qa-mission-2026-11-17/PAKDAM_GAME_LOGIC_AUDIT.md.
const mkTimedState = (phase: 'ACTIVE' | 'HEAD_START' | 'LOBBY', extraPlayers: Player[] = [], configOver: Record<string, unknown> = {}): RoomDoState => ({
  ...mkState(),
  players: [...mkState().players, ...extraPlayers],
  room: {
    ...mkRoom(), phase,
    startedAt: new Date(1000).toISOString(), endsAt: new Date(1000 + 600_000).toISOString(),
    config: {
      mode: 'classic', teamAssignment: 'random', maxPlayers: 30, hunterCount: 1,
      durationSeconds: 600, headStartSeconds: 60, pingIntervalSeconds: 180,
      zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 300,
      catchConfirmationRequired: true, playZoneEnabled: true,
      balanceHunters: true, randomDraw: true,
      zone: { boundary: [], shrinkPhases: [] }, safeAreas: [], noGoAreas: [],
      selectedHunterIds: [], hostOnSiteConfirmed: true, ...configOver,
    } as never,
  },
});

test('GL-01: alarmTick match end completes (no INVALID_STATE throw) and reports runners-win on time', () => {
  const tick = alarmTick(mkTimedState('ACTIVE'), 1000 + 600_000 + 1000);
  assert.equal(tick.state.room.phase, 'COMPLETED');
  assert.equal(tick.state.room.result?.outcome, 'runners-win');
  assert.deepEqual(tick.state.room.result?.survivingRunnerIds, ['r1']);
  assert.equal(tick.messages[0]?.type, 'match.completed');
});

test('GL-01b: alarmTick match end is hunters-win when the last free Runner was caught and the other was ejected', () => {
  const state = mkTimedState('ACTIVE', [{ ...mkPlayer('r2'), ejectedAt: new Date(2000).toISOString() }]);
  // Roster is h1 (Hunter), r1 (Runner), r2 (Runner, ejected).
  const req = send(state, 'h1', 'catch.request', { runnerId: 'r1' }, 'gl-01b-1');
  const conf = send(req.state, 'r1', 'catch.confirm', { catchId: req.issuedCatchToken!.catchId, qrToken: req.issuedCatchToken!.token }, 'gl-01b-2');
  // The confirm itself completes the match (GL-02); the tick must not
  // resurrect it or throw.
  assert.equal(conf.state.room.phase, 'COMPLETED');
  assert.equal(conf.state.room.result?.outcome, 'hunters-win');
  assert.deepEqual(conf.state.room.result?.survivingRunnerIds, []);
});

test('GL-02: confirming the last Runner completes the match at once (Classic)', () => {
  let state = mkTimedState('ACTIVE');
  // Only one Runner in mkState's roster is r1; add a second runner r2
  // and catch both — the second confirm must complete the match.
  state = { ...state, players: [...state.players, mkPlayer('r2')] };
  const req1 = send(state, 'h1', 'catch.request', { runnerId: 'r1' }, 'gl-02-1');
  const conf1 = send(req1.state, 'r1', 'catch.confirm', { catchId: req1.issuedCatchToken!.catchId, qrToken: req1.issuedCatchToken!.token }, 'gl-02-2');
  assert.equal(conf1.state.room.phase, 'ACTIVE', 'one Runner left — match continues');
  const req2 = send(conf1.state, 'h1', 'catch.request', { runnerId: 'r2' }, 'gl-02-3');
  const conf2 = send(req2.state, 'r2', 'catch.confirm', { catchId: req2.issuedCatchToken!.catchId, qrToken: req2.issuedCatchToken!.token }, 'gl-02-4');
  assert.equal(conf2.state.room.phase, 'COMPLETED');
  assert.equal(conf2.state.room.result?.outcome, 'hunters-win');
  assert.equal(conf2.replies.some((r) => r.type === 'match.completed'), true);
});

test('GL-02b: Infection — a confirmed catch flips the Runner to Hunter', () => {
  const state = mkTimedState('ACTIVE', [mkPlayer('r2')], { mode: 'infection' });
  const req = send(state, 'h1', 'catch.request', { runnerId: 'r1' }, 'gl-02b-1');
  const conf = send(req.state, 'r1', 'catch.confirm', { catchId: req.issuedCatchToken!.catchId, qrToken: req.issuedCatchToken!.token }, 'gl-02b-2');
  assert.equal(conf.state.players.find((p) => p.playerId === 'r1')?.matchRole, 'hunter');
  assert.equal(conf.state.players.find((p) => p.playerId === 'r1')?.team, 'hunters');
  assert.equal(conf.state.room.phase, 'ACTIVE', 'one Runner still free — match continues');
});

test('GL-02c: ejecting the last free Runner completes the match hunters-win', () => {
  const state = mkTimedState('ACTIVE', [], {});
  const ejected = { ...state, outsideSinceMs: { r1: 1000 }, outsideAccumMs: {} };
  const tick = alarmTick(ejected, 1000 + 30_000);
  assert.ok(tick.state.players.find((p) => p.playerId === 'r1')?.ejectedAt);
  assert.equal(tick.state.room.phase, 'COMPLETED');
  assert.equal(tick.state.room.result?.outcome, 'hunters-win');
});

test('GL-03: startMatch assigns roles, enforces min-3 / all-ready / host-only', () => {
  const lobby = (players: Player[], configOver: Record<string, unknown> = {}): RoomDoState => ({
    ...mkTimedState('LOBBY', [], configOver), players,
    room: { ...mkTimedState('LOBBY', [], configOver).room, phase: 'LOBBY' as const },
  });
  const three = lobby([mkPlayer('h1', true), mkPlayer('r1'), mkPlayer('r2')]);
  const ok = startMatch(three, 'h1', 5000);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.state.room.phase, 'HEAD_START');
    assert.equal(ok.state.players.filter((p) => p.matchRole === 'hunter').length, 1);
    assert.ok(ok.state.room.startedAt && ok.state.room.endsAt);
  }
  assert.equal(startMatch(lobby([mkPlayer('h1', true), mkPlayer('r1')]), 'h1', 5000).ok, false);
  assert.equal(startMatch(lobby([mkPlayer('h1', true), mkPlayer('r1'), { ...mkPlayer('r2'), isReady: false }]), 'h1', 5000).ok, false);
  assert.equal(startMatch(three, 'r1', 5000).ok, false, 'only the host may start');
  assert.equal(startMatch(three, 'h1', 5000).ok, true);
  const started = startMatch(three, 'h1', 5000);
  assert.equal(started.ok && startMatch(started.state, 'h1', 6000).ok, false, 'cannot start twice');
});

test('GL-03b: startMatch honours host-picked Hunters and rejects a short pick instead of silently drawing', () => {
  const base = mkTimedState('LOBBY', [mkPlayer('r2')], { teamAssignment: 'selected', balanceHunters: false, hunterCount: 2, selectedHunterIds: ['r1', 'r2'] });
  const picked = startMatch(base, 'h1', 5000);
  assert.equal(picked.ok, true);
  if (picked.ok) assert.deepEqual(picked.state.players.filter((p) => p.matchRole === 'hunter').map((p) => p.playerId).sort(), ['r1', 'r2']);
  const short = mkTimedState('LOBBY', [mkPlayer('r2')], { teamAssignment: 'selected', balanceHunters: false, hunterCount: 2, selectedHunterIds: [] });
  assert.equal(startMatch(short, 'h1', 5000).ok, false);
});

test('GL-04: manual-confirm fallback — Runner confirms without a QR token', () => {
  const state = mkTimedState('ACTIVE');
  const req = send(state, 'h1', 'catch.request', { runnerId: 'r1' }, 'gl-04-1');
  const noFlag = send(req.state, 'r1', 'catch.confirm', { catchId: req.issuedCatchToken!.catchId }, 'gl-04-2');
  assert.equal(errCode(noFlag), 'VALIDATION_FAILED', 'a bare confirm with no token and no flag is still rejected');
  const manual = send(req.state, 'r1', 'catch.confirm', { catchId: req.issuedCatchToken!.catchId, manualConfirm: true }, 'gl-04-3');
  assert.equal(errCode(manual), null);
  assert.equal(manual.state.catches[0]?.state, 'confirmed');
  assert.equal(manual.state.catches[0]?.resolution, 'manual-confirm');
});

test('GL-05: one pending catch per Runner (any Hunter) and no catch on an ejected Runner', () => {
  const state = mkTimedState('ACTIVE', [{ ...mkPlayer('h2'), matchRole: 'hunter', team: 'hunters' }]);
  const first = send(state, 'h1', 'catch.request', { runnerId: 'r1' }, 'gl-05-1');
  assert.equal(errCode(first), null);
  const second = send(first.state, 'h2', 'catch.request', { runnerId: 'r1' }, 'gl-05-2');
  assert.equal(errCode(second), 'CONFLICT');
  assert.equal(second.state.catches.length, 1);
  const ejected = mkTimedState('ACTIVE', [{ ...mkPlayer('r2'), matchRole: 'runner', team: 'runners', ejectedAt: new Date(2000).toISOString() } as never]);
  assert.equal(errCode(send(ejected, 'h1', 'catch.request', { runnerId: 'r2' }, 'gl-05-3')), 'VALIDATION_FAILED');
});

test('GL-06/GL-09: catches only while ACTIVE — not in HEAD_START, not after COMPLETED', () => {
  assert.equal(errCode(send(mkTimedState('HEAD_START'), 'h1', 'catch.request', { runnerId: 'r1' }, 'gl-06-1')), 'INVALID_STATE');
  const state = mkTimedState('ACTIVE');
  const req = send(state, 'h1', 'catch.request', { runnerId: 'r1' }, 'gl-09-1');
  const done = { ...req.state, room: { ...req.state.room, phase: 'COMPLETED' as const, result: { outcome: 'runners-win' as const, durationSeconds: 600, caughtRunnerIds: [], survivingRunnerIds: ['r1'] } } };
  assert.equal(errCode(send(done, 'r1', 'catch.confirm', { catchId: req.issuedCatchToken!.catchId, qrToken: req.issuedCatchToken!.token }, 'gl-09-2')), 'INVALID_STATE');
});

test('GL-07: catchConfirmationRequired=false does NOT count the tag at once — Runner confirmation is always required', () => {
  const state = mkTimedState('ACTIVE', [], { catchConfirmationRequired: false });
  const req = send(state, 'h1', 'catch.request', { runnerId: 'r1' }, 'gl-07-1');
  assert.equal(errCode(req), null);
  assert.equal(req.state.catches[0]?.state, 'requested');
  assert.equal(req.replies.some((r) => r.type === 'catch.confirmed'), false);
  assert.equal(req.replies.some((r) => r.type === 'catch.requested'), true);
  assert.equal(req.state.room.phase, 'ACTIVE');
});

test('GL-08: safety resume returns to the phase the match was paused from', () => {
  const state = mkTimedState('HEAD_START');
  const pause = send(state, 'h1', 'safety.pause', { reason: 'break' }, 'gl-08-1');
  assert.equal(pause.state.room.phase, 'SAFETY_PAUSED');
  const resume = send(pause.state, 'h1', 'safety.resume', {}, 'gl-08-2');
  assert.equal(errCode(resume), null);
  assert.equal(resume.state.room.phase, 'HEAD_START', 'head start survives the pause');
});

test('BE-10: startMatch with host-picked Hunters + Balance ON never deadlocks when the balanced count differs', () => {
  // 6 players, stored hunterCount 1, host picked 1 Hunter — but Balance
  // sets the effective count to 2. The lobby UI only lets the host pick
  // exactly the stored hunterCount, so the old strict check ("host must
  // pick exactly 2") 409'd forever and the match could never start.
  // A stale pick now falls back to a random draw instead of failing.
  const state = mkTimedState('LOBBY', [mkPlayer('p2'), mkPlayer('p3'), mkPlayer('p4'), mkPlayer('p5')], {
    teamAssignment: 'selected', selectedHunterIds: ['r1'],
  });
  assert.equal(state.players.length, 6);
  const started = startMatch(state, 'h1', 5000);
  assert.equal(started.ok, true, started.ok ? '' : (started as { error: string }).error);
  if (started.ok) {
    assert.equal(started.state.room.phase, 'HEAD_START');
    assert.equal(started.state.players.filter((p) => p.matchRole === 'hunter').length, 2);
    assert.equal(started.state.room.config.hunterCount, 2);
  }
  // Exact pick still honoured when it matches the effective count.
  const exact = mkTimedState('LOBBY', [mkPlayer('p2'), mkPlayer('p3'), mkPlayer('p4'), mkPlayer('p5')], {
    teamAssignment: 'selected', selectedHunterIds: ['r1', 'p2'],
  });
  const startedExact = startMatch(exact, 'h1', 5000);
  assert.equal(startedExact.ok, true);
  if (startedExact.ok) {
    assert.deepEqual(startedExact.state.players.filter((p) => p.matchRole === 'hunter').map((p) => p.playerId).sort(), ['p2', 'r1']);
  }
});

test('MP-ROLE-LEAK (SEC-13 re-review, DECIDED 2026-11-17 recovery): a seat sees its OWN TEAM only — the other team\'s roles are hidden in every phase', () => {
  // Decision (recovery 2026-11-17, over Worker 5's "visible once live"
  // design and over the wiring's phase-gated reveal): checklist rule is
  // "own team live, other team only via pings" — in-match a Runner must
  // NOT see Hunters' roles and vice versa. Own role + same-team roles
  // stay visible. Locations stay hidden either way — only coarse pings
  // + own-team live.
  const state = mkState(); // h1 hunter (host), r1 runner; phase ACTIVE
  const runnerSnap = buildWsSnapshot(state, 'r1', 5000);
  const hostSnap = buildWsSnapshot(state, 'h1', 5000);
  if (runnerSnap.type !== 'snapshot' || hostSnap.type !== 'snapshot') assert.fail('snapshots expected');
  // LIVE: own role visible, other team's roles null.
  assert.equal(runnerSnap.payload.players.find((p) => p.playerId === 'r1')?.matchRole, 'runner');
  assert.equal(runnerSnap.payload.players.find((p) => p.playerId === 'h1')?.matchRole, null);
  assert.equal(runnerSnap.payload.players.find((p) => p.playerId === 'h1')?.team, null);
  assert.equal(hostSnap.payload.players.find((p) => p.playerId === 'r1')?.matchRole, null);
  assert.equal(hostSnap.payload.players.find((p) => p.playerId === 'r1')?.team, null);
  assert.equal(hostSnap.payload.players.find((p) => p.playerId === 'h1')?.matchRole, 'hunter');
  // PRE-GAME: roles masked for everyone except their own seat.
  const lobby = { ...mkState(), room: { ...mkRoom(), phase: 'LOBBY' as const } };
  const lobbySnap = buildWsSnapshot(lobby, 'r1', 5000);
  if (lobbySnap.type !== 'snapshot') assert.fail('lobby snapshot expected');
  assert.equal(lobbySnap.payload.players.find((p) => p.playerId === 'r1')?.matchRole, 'runner');
  assert.equal(lobbySnap.payload.players.find((p) => p.playerId === 'h1')?.matchRole, null);
  assert.equal(lobbySnap.payload.players.find((p) => p.playerId === 'h1')?.team, null);
});

test('MP-HOST-LEAVE: host leaving transfers host to the earliest-joined player still in the room', () => {
  const state = mkState(); // LOBBY? mkState is ACTIVE; leave works in any phase
  const res = handleWsClientMessage(state, 'h1', {
    v: 1, type: 'leave', roomId: 'r1', playerId: 'h1', clientSeq: 1, clientTs: 5000,
    commandId: 'cmd-leave-host', payload: {},
  }, 5000);
  const transfer = res.replies.find((r) => r.type === 'host.transferred');
  assert.ok(transfer, 'host.transferred must be emitted');
  if (transfer?.type === 'host.transferred') {
    assert.equal(transfer.payload.previousHostPlayerId, 'h1');
    assert.equal(transfer.payload.newHostPlayerId, 'r1');
  }
  assert.equal(res.state.room.hostPlayerId, 'r1');
  assert.equal(res.state.players.find((p) => p.playerId === 'r1')?.isHost, true);
  assert.equal(res.state.players.find((p) => p.playerId === 'h1')?.isHost, false);
  // A non-host leaving transfers nothing.
  const res2 = handleWsClientMessage(mkState(), 'r1', {
    v: 1, type: 'leave', roomId: 'r1', playerId: 'r1', clientSeq: 1, clientTs: 5000,
    commandId: 'cmd-leave-runner', payload: {},
  }, 5000);
  assert.equal(res2.replies.some((r) => r.type === 'host.transferred'), false);
  assert.equal(res2.state.room.hostPlayerId, 'h1');
  // A lone host leaving transfers to nobody — no crash, no transfer message.
  const solo: RoomDoState = { ...mkState(), players: [mkPlayer('h1', true)] };
  const res3 = handleWsClientMessage(solo, 'h1', {
    v: 1, type: 'leave', roomId: 'r1', playerId: 'h1', clientSeq: 1, clientTs: 5000,
    commandId: 'cmd-leave-solo', payload: {},
  }, 5000);
  assert.equal(res3.replies.some((r) => r.type === 'host.transferred'), false);
  assert.equal(res3.state.room.hostPlayerId, 'h1');
});

// ===========================================================================
// SEC-13 hardening (2026-11-17): host takeover, ticket renewal, rate
// limits, fix purge / TTL. These pin the QA mission's open P0s shut.
// ===========================================================================

test('SEC-06 (host takeover): a display name alone never restores the host seat — only the seat token does', () => {
  const active = { ...mkState(), room: { ...mkRoom(), phase: 'ACTIVE' as const } };
  // Attacker re-joins with the host's display name 'H1', no token.
  assert.throws(() => addPlayer(active, 'H1', 'guest', 5000), /reconnect token/i);
  assert.throws(() => addPlayer(active, 'H1', 'guest', 5000, { reconnectToken: 'attacker-guess' }), /reconnect token/i);
  // Even the RUNNER's own token does not restore the HOST seat.
  assert.throws(() => addPlayer(active, 'H1', 'guest', 5000, { reconnectToken: 'reconnect-r1' }), /reconnect token/i);
  // The host seat is untouched: still h1, still the only host.
  assert.equal(active.players.filter((p) => p.isHost).length, 1);
  assert.equal(active.room.hostPlayerId, 'h1');
  // The real host restores with its own token and keeps host powers.
  const restored = addPlayer(active, 'H1', 'guest', 5000, { reconnectToken: 'reconnect-h1' });
  assert.equal(restored.restored, true);
  assert.equal(restored.player.playerId, 'h1');
  assert.equal(restored.player.isHost, true);
  assert.equal(restored.state.room.hostPlayerId, 'h1');
});

test('SEC-10: verifyReconnectToken — true only for the exact seat token, false for anything else', () => {
  const state = mkState();
  assert.equal(verifyReconnectToken(state, 'h1', 'reconnect-h1'), true);
  assert.equal(verifyReconnectToken(state, 'h1', 'reconnect-r1'), false, 'another seat token is not this seat');
  assert.equal(verifyReconnectToken(state, 'h1', 'wrong'), false);
  assert.equal(verifyReconnectToken(state, 'h1', ''), false);
  assert.equal(verifyReconnectToken(state, 'nobody', 'reconnect-h1'), false);
  // A seat with no stored hash never verifies — but the Player type
  // now requires reconnectTokenHash: string, so a null-hash seat is
  // unrepresentable; the wrong-token / empty-token cases above cover
  // the same false branch (sha256Hex(token) === hash can never hold
  // without the matching hash).
});

test('SEC-11: auth.refresh redeems a registered RENEW ticket once — then it is TICKET_REUSED', () => {
  const rawRenew = 'renew-ticket-raw-value';
  const rec = {
    ticketId: 't-renew-1', hash: sha256Hex(rawRenew), roomId: 'r1', playerId: 'r1',
    purpose: 'renew' as const, issuedAtMs: 1000, expiresAtMs: 1000 + 60_000, status: 'valid' as const,
  };
  let state = registerWsTicket(mkState(), rec);
  const ok = send(state, 'r1', 'auth.refresh', { ticket: rawRenew }, 'cmd-refresh-1', 5000);
  assert.equal(ok.authRefreshed?.ticketId, 't-renew-1');
  assert.equal(ok.authRefreshed?.expiresAtMs, 1000 + 60_000);
  assert.equal(ok.replies.some((r) => r.type === 'auth.refreshed'), true);
  assert.equal(ok.authRefreshFailed, undefined);
  state = ok.state;
  // Second use of the same ticket is a reuse — the DO closes the
  // socket 4401 (authRefreshFailed) and no fresh credential is issued.
  const again = send(state, 'r1', 'auth.refresh', { ticket: rawRenew }, 'cmd-refresh-2', 6000);
  assert.equal(again.authRefreshFailed?.code, 'TICKET_REUSED');
  assert.equal(again.authRefreshed, undefined);
  assert.equal(errCode(again), 'TICKET_REUSED');
});

test('SEC-11: auth.refresh rejects a CONNECT ticket and an unknown ticket — neither renews the socket', () => {
  const rawConnect = 'connect-ticket-raw-value';
  const state = registerWsTicket(mkState(), {
    ticketId: 't-connect-1', hash: sha256Hex(rawConnect), roomId: 'r1', playerId: 'r1',
    purpose: 'connect' as const, issuedAtMs: 1000, expiresAtMs: 1000 + 60_000, status: 'valid' as const,
  });
  const connectRes = send(state, 'r1', 'auth.refresh', { ticket: rawConnect }, 'cmd-refresh-3', 5000);
  assert.equal(connectRes.authRefreshFailed?.code, 'TICKET_INVALID');
  assert.equal(connectRes.authRefreshed, undefined);
  const unknown = send(state, 'r1', 'auth.refresh', { ticket: 'never-issued' }, 'cmd-refresh-4', 5000);
  assert.equal(unknown.authRefreshFailed?.code, 'TICKET_INVALID');
  const empty = send(state, 'r1', 'auth.refresh', {}, 'cmd-refresh-5', 5000);
  assert.equal(errCode(empty), 'VALIDATION_FAILED');
});

test('SEC-11: ticketRenewalDue warns only inside the 30 s window, never after expiry', () => {
  assert.equal(ticketRenewalDue(100_000, 69_999), false, '31 s out — not yet');
  assert.equal(ticketRenewalDue(100_000, 70_000), true, 'exactly 30 s out — warn now');
  assert.equal(ticketRenewalDue(100_000, 99_999), true);
  assert.equal(ticketRenewalDue(100_000, 100_000), false, 'already expired — too late to warn');
});

test('SEC-12: WS per-seat rate limits — ready.set 10/min, location.update 60/10 s, then RATE_LIMITED with retry-after', () => {
  let state = mkState();
  for (let i = 0; i < 10; i++) {
    const r = checkWsRate(state, 'r1', 'ready.set', 5000);
    assert.equal(r.allowed, true, `ready.set #${i + 1} allowed`);
    state = r.state;
  }
  const denied = checkWsRate(state, 'r1', 'ready.set', 5000);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSeconds, 60);
  // A different seat has its own window.
  assert.equal(checkWsRate(state, 'h1', 'ready.set', 5000).allowed, true);
  // location.update: 60 per 10 s, then denied.
  let s2 = mkState();
  for (let i = 0; i < 60; i++) {
    const r = checkWsRate(s2, 'r1', 'location.update', 5000);
    assert.equal(r.allowed, true, `location.update #${i + 1} allowed`);
    s2 = r.state;
  }
  const deniedLoc = checkWsRate(s2, 'r1', 'location.update', 5000);
  assert.equal(deniedLoc.allowed, false);
  assert.equal(deniedLoc.retryAfterSeconds, 10);
  // The limit is enforced on the wire too: a rate-limited command
  // gets a RATE_LIMITED error reply and the socket stays open.
  let s3 = mkState();
  for (let i = 0; i < 10; i++) {
    const r = send(s3, 'r1', 'ready.set', { isReady: true }, `cmd-ready-${i}`, 5000);
    s3 = r.state;
  }
  const limited = send(s3, 'r1', 'ready.set', { isReady: true }, 'cmd-ready-11', 5000);
  assert.equal(errCode(limited), 'RATE_LIMITED');
});

test('SEC-12: HTTP rate limits — room create 5/min per IP, ws-ticket 10/min per seat, start 5/min per seat', () => {
  for (let i = 0; i < 5; i++) assert.equal(createAllowed('1.2.3.4', 1000), true);
  assert.equal(createAllowed('1.2.3.4', 1000), false);
  assert.equal(createAllowed('5.6.7.8', 1000), true, 'a different IP has its own window');
  for (let i = 0; i < 10; i++) assert.equal(ticketAllowed('r1', 'p1', 1000), true);
  assert.equal(ticketAllowed('r1', 'p1', 1000), false);
  assert.equal(ticketAllowed('r1', 'p2', 1000), true, 'a different seat has its own window');
  assert.equal(ticketRevokeAllowed('r1', 'p1', 1000), true);
  for (let i = 0; i < 5; i++) assert.equal(startAllowed('r1', 'p1', 1000), true);
  assert.equal(startAllowed('r1', 'p1', 1000), false);
  // Windows slide: after the window passes, the limit resets.
  assert.equal(createAllowed('1.2.3.4', 1000 + 61_000), true);
});

test('SEC-13: completeMatch purges every raw fix, pending ping and outside-zone counter (HNT-068)', () => {
  const state: RoomDoState = {
    ...mkState(),
    latestFix: { r1: mkFix('r1', 4000) },
    pendingPings: [mkPing()],
    outsideSinceMs: { r1: 1000 },
    outsideAccumMs: { r1: 5000 },
  };
  const done = completeMatch(state, {
    outcome: 'hunters-win', durationSeconds: 600,
    caughtRunnerIds: [], survivingRunnerIds: ['r1'],
  }, 'h1', 6000);
  assert.equal(done.room.phase, 'COMPLETED');
  assert.deepEqual(done.latestFix, {});
  assert.deepEqual(done.pendingPings, []);
  assert.deepEqual(done.outsideSinceMs, {});
  assert.deepEqual(done.outsideAccumMs, {});
});

test('SEC-13: fix TTL — a fix older than FIX_TTL_MS is dropped and the player goes unknown; a fresh fix survives', () => {
  assert.equal(FIX_TTL_MS, 120_000, 'TTL is the documented 120 s placeholder');
  const stale = purgeStaleFixes(mkState(), 4000 + FIX_TTL_MS + 1);
  assert.deepEqual(stale.latestFix, {}, 'mkState fix (received 4000 ms) is stale at 124001 ms');
  assert.equal(stale.players.find((p) => p.playerId === 'r1')?.locationQuality, 'unknown');
  const fresh = purgeStaleFixes({ ...mkState(), latestFix: { r1: mkFix('r1', 125_000) } }, 130_000);
  assert.ok(fresh.latestFix['r1'], 'a 5 s old fix survives the TTL');
  // The alarm tick purges stale fixes on its own pass too.
  const ticked = alarmTick(mkState(), 4000 + FIX_TTL_MS + 1);
  assert.deepEqual(ticked.state.latestFix, {});
});

test('SEC-14: ticket records and rate windows are memory-only — never in the recovery snapshot, reset on recovery', () => {
  const raw = 'renew-for-recovery';
  const state = registerWsTicket(mkState(), {
    ticketId: 't-rec-1', hash: sha256Hex(raw), roomId: 'r1', playerId: 'r1',
    purpose: 'renew' as const, issuedAtMs: 1000, expiresAtMs: 1000 + 60_000, status: 'valid' as const,
  });
  const rated = checkWsRate(state, 'r1', 'ready.set', 5000).state;
  const snap = snapshotForRecovery(rated);
  assert.equal('wsTickets' in snap, false);
  assert.equal('wsRate' in snap, false);
  assert.equal('latestFix' in snap, false, 'coordinates are never persisted either (HNT-068)');
  const recovered = recoverState(snap);
  assert.deepEqual(recovered.wsTickets, []);
  assert.deepEqual(recovered.wsRate, {});
  assert.deepEqual(recovered.latestFix, {});
});
