import test from 'node:test';
import assert from 'node:assert/strict';
import {
  route, createRoomBody, joinBody, ticketBody, hostTokenBody,
  lifecycleBody, transferBody, resolveBody, bugReportBody,
  grievanceBody, reportBody,
} from '../src/http.js';

// The Worker entry (workers/src/index.ts) implements these routes.
// The Zod layer is shape-only validation; domain rules live in
// validateRoomConfig (shared) and the Durable Object.

test('routes: create, join, ws-ticket, revoke-before-ws-ticket, websocket, get-state', () => {
  assert.equal(route('/v1/rooms'), 'create-room');
  assert.equal(route('/v1/rooms/abc/join'), 'join');
  assert.equal(route('/v1/rooms/abc'), 'get-state');
  assert.equal(route('/v1/rooms/abc/ws-ticket'), 'ws-ticket');
  assert.equal(route('/v1/rooms/abc/ws-ticket/revoke'), 'ws-ticket-revoke');
  assert.equal(route('/v1/rooms/abc/ticket'), 'ws-ticket'); // legacy alias
  assert.equal(route('/v1/rooms/abc/ws'), 'websocket');
  assert.equal(route('/nope'), 'not-found');
  assert.equal(route('/v1/rooms'), 'create-room');
});

const validConfig = {
  mode: 'classic', teamAssignment: 'random', maxPlayers: 30, hunterCount: 1,
  durationSeconds: 600, headStartSeconds: 60, pingIntervalSeconds: 180,
  zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 300,
  catchConfirmationRequired: true, playZoneEnabled: true,
  balanceHunters: true, randomDraw: true,
  zone: {
    boundary: [
      { lat: 23.35, lng: 85.32 }, { lat: 23.35, lng: 85.325 },
      { lat: 23.355, lng: 85.325 }, { lat: 23.355, lng: 85.32 },
    ],
    shrinkPhases: [],
  },
  safeAreas: [], noGoAreas: [], selectedHunterIds: [],
  hostOnSiteConfirmed: true,
};

const validCreate = {
  displayName: 'Test Host', kind: 'guest', config: validConfig, ageGatePassed: true,
};

test('createRoomBody: a valid 30-player Classic room parses; 31 players and Zombie do not', () => {
  assert.equal(createRoomBody.safeParse(validCreate).success, true);
  assert.equal(
    createRoomBody.safeParse({ ...validCreate, config: { ...validConfig, maxPlayers: 31 } }).success,
    false,
  );
  assert.equal(
    createRoomBody.safeParse({ ...validCreate, config: { ...validConfig, mode: 'zombie' } }).success,
    false,
  );
  assert.equal(
    createRoomBody.safeParse({ ...validCreate, config: { ...validConfig, mode: 'breach' } }).success,
    false,
  );
  // STRICT object: an unknown top-level key is rejected, not ignored.
  assert.equal(createRoomBody.safeParse({ ...validCreate, surprise: 1 }).success, false);
  // ageGatePassed is required — a room cannot be created without the 18+ gate.
  assert.equal(createRoomBody.safeParse({ ...validCreate, ageGatePassed: undefined }).success, false);
});

test('createRoomBody: the Zod layer is shape-only — an empty zone boundary parses here', () => {
  // The "boundary needs >= 3 points" rule is enforced by
  // validateRoomConfig (shared), not by the shape schema. This split
  // is deliberate: the Worker runs BOTH layers in order.
  const emptyZone = { ...validCreate, config: { ...validConfig, zone: { boundary: [], shrinkPhases: [] } } };
  assert.equal(createRoomBody.safeParse(emptyZone).success, true);
});

test('joinBody: 6-char room code required; display name 1–30 chars', () => {
  assert.equal(joinBody.safeParse({ displayName: 'Runner One', kind: 'guest', roomCode: 'ABC123' }).success, true);
  assert.equal(joinBody.safeParse({ displayName: 'Runner One', kind: 'guest', roomCode: 'ABC12' }).success, false);
  assert.equal(joinBody.safeParse({ displayName: 'Runner One', kind: 'guest', roomCode: 'ABC1234' }).success, false);
  assert.equal(joinBody.safeParse({ displayName: '', kind: 'guest', roomCode: 'ABC123' }).success, false);
  assert.equal(joinBody.safeParse({ displayName: 'Runner One', kind: 'host', roomCode: 'ABC123' }).success, false);
});

test('ticketBody: playerId + reconnectToken are both required', () => {
  assert.equal(ticketBody.safeParse({ playerId: 'p1', reconnectToken: 'tok' }).success, true);
  assert.equal(ticketBody.safeParse({ playerId: 'p1' }).success, false);
  assert.equal(ticketBody.safeParse({ reconnectToken: 'tok' }).success, false);
});

// --- Worker 5 (2026-11-17): host-token routes, lifecycle, results, support intake ---

test('routes: lifecycle, host/token, host/transfer, catch resolve, results, reports, bugs, grievances', () => {
  assert.equal(route('/v1/rooms/abc/lifecycle'), 'lifecycle');
  assert.equal(route('/v1/rooms/abc/host/token'), 'host-token');
  assert.equal(route('/v1/rooms/abc/host/transfer'), 'host-transfer');
  assert.equal(route('/v1/rooms/abc/catches/catch-1/resolve'), 'catch-resolve');
  assert.equal(route('/v1/rooms/abc/results'), 'results');
  assert.equal(route('/v1/reports'), 'reports');
  assert.equal(route('/v1/support/bugs'), 'bugs');
  assert.equal(route('/v1/support/grievances'), 'grievances');
  // Catches / SOS / leave stay WS-only by design (see http.ts): no
  // REST route is registered for them — they 404 over HTTP.
  assert.equal(route('/v1/rooms/abc/catches'), 'not-found');
  assert.equal(route('/v1/rooms/abc/safety/sos'), 'not-found');
  assert.equal(route('/v1/rooms/abc/leave'), 'not-found');
  // Existing routes are unchanged.
  assert.equal(route('/v1/rooms/abc/catch-token'), 'catch-token');
  assert.equal(route('/v1/rooms/abc/config'), 'config');
  assert.equal(route('/v1/rooms/abc/remove-player'), 'remove-player');
});

test('hostTokenBody: playerId + hostToken are both required (start/config/remove/transfer/resolve)', () => {
  assert.equal(hostTokenBody.safeParse({ playerId: 'h1', hostToken: 'tok' }).success, true);
  assert.equal(hostTokenBody.safeParse({ playerId: 'h1' }).success, false);
  assert.equal(hostTokenBody.safeParse({ hostToken: 'tok' }).success, false);
  // A reconnect token is NOT a host token: the field name is different
  // and the strict schema rejects the wrong shape.
  assert.equal(hostTokenBody.safeParse({ playerId: 'h1', reconnectToken: 'tok' }).success, false);
});

test('lifecycleBody: start/resume/end take hostToken, pause takes reconnectToken; unknown actions rejected', () => {
  assert.equal(lifecycleBody.safeParse({ action: 'start', playerId: 'h1', hostToken: 'tok' }).success, true);
  assert.equal(lifecycleBody.safeParse({ action: 'pause', playerId: 'r1', reconnectToken: 'tok' }).success, true);
  assert.equal(lifecycleBody.safeParse({ action: 'resume', playerId: 'h1', hostToken: 'tok' }).success, true);
  assert.equal(lifecycleBody.safeParse({ action: 'end', playerId: 'h1', hostToken: 'tok' }).success, true);
  assert.equal(lifecycleBody.safeParse({ action: 'explode', playerId: 'h1' }).success, false);
  assert.equal(lifecycleBody.safeParse({ action: 'start', playerId: 'h1' }).success, true, 'shape-only: the Worker enforces which credential is present per action');
});

test('transferBody / resolveBody: hostToken required; resolve decision is confirmed|rejected only', () => {
  assert.equal(transferBody.safeParse({ playerId: 'h1', hostToken: 'tok', newHostPlayerId: 'r1' }).success, true);
  assert.equal(transferBody.safeParse({ playerId: 'h1', newHostPlayerId: 'r1' }).success, false);
  assert.equal(resolveBody.safeParse({ playerId: 'h1', hostToken: 'tok', decision: 'confirmed' }).success, true);
  assert.equal(resolveBody.safeParse({ playerId: 'h1', hostToken: 'tok', decision: 'rejected' }).success, true);
  assert.equal(resolveBody.safeParse({ playerId: 'h1', hostToken: 'tok', decision: 'maybe' }).success, false);
  assert.equal(resolveBody.safeParse({ playerId: 'h1', decision: 'confirmed' }).success, false);
});

test('joinBody: reconnectToken is optional for a new join (required only for a restore)', () => {
  assert.equal(joinBody.safeParse({ displayName: 'Runner One', kind: 'guest', roomCode: 'ABC123' }).success, true);
  assert.equal(joinBody.safeParse({ displayName: 'Runner One', kind: 'guest', roomCode: 'ABC123', reconnectToken: 'tok' }).success, true);
});

test('support bodies: bugs need device/app/description; grievances need ref+channel+summary; reports need a seat credential', () => {
  assert.equal(bugReportBody.safeParse({ deviceInfo: 'Pixel 8', appVersion: '0.1.0', description: 'map froze' }).success, true);
  assert.equal(bugReportBody.safeParse({ deviceInfo: 'Pixel 8', appVersion: '0.1.0' }).success, false);
  assert.equal(grievanceBody.safeParse({ complainantRef: 'runner-1', channel: 'in-app', summary: 'unfair tag' }).success, true);
  assert.equal(grievanceBody.safeParse({ complainantRef: 'runner-1', channel: 'sms', summary: 'x' }).success, false);
  assert.equal(reportBody.safeParse({ roomId: 'r1', playerId: 'r1', reconnectToken: 'tok', kind: 'report', reason: 'abuse' }).success, true);
  assert.equal(reportBody.safeParse({ roomId: 'r1', playerId: 'r1', kind: 'report', reason: 'abuse' }).success, false);
});
