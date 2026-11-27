import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

register('../resolve-hooks.mjs', import.meta.url);

const { hashAdminPassword, mintAdminToken } = await import('../src/admin-auth.ts');
const { clearRuntimeFlagCache } = await import('../src/admin-flags.ts');
const { adminCan, sha256Hex } = await import('@pakdam/shared');
const admin = await import('../src/admin.ts');
const http = await import('../src/http.ts');

// ---------------------------------------------------------------------------
// Fake PostgREST (in-memory tables, just enough of the PostgREST query
// language for the admin handlers: select, eq/gte/lt/is filters,
// order, limit, insert/patch/delete, Prefer: count=exact).
// ---------------------------------------------------------------------------

const NOW = '2026-11-25T12:00:00.000Z';
const OWNER_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const ADMIN_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const STAFF_ID = 'cccccccc-3333-4333-8333-333333333333';
const PLAYER_ID = 'dddddddd-4444-4444-8444-444444444444';
const ROOM_ID = 'eeeeeeee-5555-4555-8555-555555555555';

function defaultFlags() {
  return [
    { key: 'radio', enabled: true, updated_by: null, updated_at: null },
    { key: 'pings', enabled: true, updated_by: null, updated_at: null },
    { key: 'zone', enabled: true, updated_by: null, updated_at: null },
    { key: 'gameStart', enabled: true, updated_by: null, updated_at: null },
    { key: 'demoMode', enabled: false, updated_by: null, updated_at: null },
    { key: 'voiceText', enabled: true, updated_by: null, updated_at: null },
    { key: 'qrInvite', enabled: true, updated_by: null, updated_at: null },
    { key: 'billing.overview', enabled: false, updated_by: null, updated_at: null },
    { key: 'billing.transactions', enabled: false, updated_by: null, updated_at: null },
    { key: 'billing.plans', enabled: false, updated_by: null, updated_at: null },
    { key: 'billing.providers', enabled: false, updated_by: null, updated_at: null },
    { key: 'billing.refunds', enabled: false, updated_by: null, updated_at: null },
    { key: 'billing.tax', enabled: false, updated_by: null, updated_at: null },
    { key: 'accounts.directory', enabled: false, updated_by: null, updated_at: null },
    { key: 'accounts.roles', enabled: false, updated_by: null, updated_at: null },
    { key: 'accounts.bans', enabled: false, updated_by: null, updated_at: null },
    { key: 'accounts.dataRequests', enabled: false, updated_by: null, updated_at: null },
    { key: 'accounts.loginMethods', enabled: false, updated_by: null, updated_at: null },
  ];
}

function createDb(seed = {}) {
  const db = {
    admin_users: [],
    admin_sessions: [],
    admin_login_attempts: [],
    feature_flags: defaultFlags(),
    game_config: [
      {
        key: 'default',
        duration_seconds: 1800,
        head_start_seconds: 180,
        ping_interval_seconds: 180,
        zone_radius_metres: 500,
        zone_shrink_interval_seconds: 600,
        zone_shrink_enabled: true,
      },
    ],
    announcements: [],
    blocks: [],
    admin_audit_log: [],
    rooms: [],
    players: [],
    catches: [],
    safety_events: [],
    audit_log: [],
    logs: [],
    safety_flags: [],
    data_requests: [],
    billing_transactions: [],
    room_events: [],
    bug_reports: [],
    ...seed,
  };
  return db;
}

function matchesFilter(row, col, expr) {
  if (expr === 'is.null') return row[col] === null || row[col] === undefined;
  if (expr === 'is.not.null') return row[col] !== null && row[col] !== undefined;
  const dot = expr.indexOf('.');
  const op = expr.slice(0, dot);
  const raw = expr.slice(dot + 1);
  const value = row[col];
  if (op === 'eq') {
    if (raw === 'true') return value === true;
    if (raw === 'false') return value === false;
    return String(value ?? '') === decodeURIComponent(raw);
  }
  if (op === 'gte') return String(value ?? '') >= decodeURIComponent(raw);
  if (op === 'lt') return String(value ?? '') < decodeURIComponent(raw);
  // Fix round 4 (M3-4): the erase scrub pages by keyset
  // (`<id>=gt.<last-seen>`), so the fake must speak PostgREST `gt`.
  if (op === 'gt') return String(value ?? '') > decodeURIComponent(raw);
  return true;
}

function makeFetch(db, options = {}) {
  const failInsertTables = options.failInsertTables ?? new Set();
  const failDeleteTables = options.failDeleteTables ?? new Set();
  // The setup RPC serializes through a promise chain — the fake
  // equivalent of Postgres' advisory lock inside admin_setup_owner()
  // (migration 0011). Two concurrent setups must yield one 201 and
  // one 409, never two Owners.
  let rpcLock = Promise.resolve();
  return async (url, init = {}) => {
    const u = new URL(url);
    // PostgREST RPC: POST /rest/v1/rpc/<fn>. Only admin_setup_owner
    // is used by the server under test.
    if (u.pathname.endsWith('/rpc/admin_setup_owner')) {
      const run = rpcLock.then(async () => {
        const args = JSON.parse(init.body);
        if (db.admin_users.length > 0) {
          return new Response(JSON.stringify({ ok: false, error: 'already_setup' }), { status: 200 });
        }
        const id = randomUUID();
        db.admin_users.push({
          id,
          username: args.p_username,
          role: 'owner',
          password_hash: args.p_password_hash,
          created_at: NOW,
          last_login_at: null,
          disabled: false,
          must_change_password: false,
        });
        return new Response(JSON.stringify({ ok: true, id }), { status: 200 });
      });
      rpcLock = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }
    const table = u.pathname.split('/').pop();
    if (!table || !(table in db)) {
      return new Response(JSON.stringify({ message: 'table not found' }), { status: 404 });
    }
    const method = (init.method ?? 'GET').toUpperCase();
    const params = u.searchParams;
    const headers = init.headers ?? {};
    const prefer = typeof headers === 'object' ? headers['Prefer'] ?? headers['prefer'] ?? '' : '';
    const rows = db[table];
    const filters = [];
    for (const [k, v] of params.entries()) {
      if (k === 'select' || k === 'order' || k === 'limit' || k === 'offset') continue;
      filters.push([k, v]);
    }
    const filtered = rows.filter((r) => filters.every(([c, e]) => matchesFilter(r, c, e)));
    if (method === 'GET') {
      let out = [...filtered];
      const order = params.get('order');
      if (order) {
        const [col, dir] = order.split('.');
        out.sort((a, b) => {
          const av = String(a[col] ?? '');
          const bv = String(b[col] ?? '');
          return dir === 'desc' ? (av < bv ? 1 : -1) : av < bv ? -1 : 1;
        });
      }
      const limit = params.get('limit');
      const offset = Number(params.get('offset') ?? 0);
      if (limit) out = out.slice(offset, offset + Number(limit));
      else if (offset) out = out.slice(offset);
      const resHeaders = { 'Content-Type': 'application/json' };
      if (String(prefer).includes('count=exact')) {
        resHeaders['Content-Range'] = `0-${Math.max(0, out.length - 1)}/${filtered.length}`;
      }
      return new Response(JSON.stringify(out), { status: 200, headers: resHeaders });
    }
    if (method === 'POST') {
      if (failInsertTables.has(table)) {
        return new Response(JSON.stringify({ message: 'simulated insert failure' }), { status: 500 });
      }
      const body = JSON.parse(init.body);
      // admin_login_attempts has a UNIQUE (username, ip_hash)
      // constraint (migration 0011): a duplicate insert is a 409,
      // and the server re-reads + patches instead.
      if (table === 'admin_login_attempts') {
        const incoming = Array.isArray(body) ? body : [body];
        for (const r of incoming) {
          if (db[table].some((x) => x.username === r.username && x.ip_hash === r.ip_hash)) {
            return new Response(JSON.stringify({ message: 'duplicate key value violates unique constraint' }), { status: 409 });
          }
        }
      }
      const inserted = (Array.isArray(body) ? body : [body]).map((r) => {
        const row = { ...r };
        if (row.id === undefined) row.id = randomUUID();
        if (row.created_at === undefined) row.created_at = NOW;
        if (table === 'blocks' && row.blocked_at === undefined) row.blocked_at = row.created_at;
        if (table === 'announcements' && row.updated_at === undefined) row.updated_at = NOW;
        return row;
      });
      db[table].push(...inserted);
      return new Response(JSON.stringify(inserted), { status: 201 });
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(init.body);
      const updated = [];
      for (const r of filtered) {
        Object.assign(r, patch);
        updated.push({ ...r });
      }
      return new Response(JSON.stringify(updated), { status: 200 });
    }
    if (method === 'DELETE') {
      if (failDeleteTables.has(table)) {
        return new Response(JSON.stringify({ message: 'simulated delete failure' }), { status: 500 });
      }
      db[table] = db[table].filter((r) => !filtered.includes(r));
      return new Response('[]', { status: 200 });
    }
    return new Response('method not allowed', { status: 405 });
  };
}

// ---------------------------------------------------------------------------
// Harness: fake DO stub + fake ExecutionContext + authed requests
// ---------------------------------------------------------------------------

function makeDoStub(calls, db = null) {
  return {
    idFromName: (name) => name,
    get: (roomId) => ({
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        calls.push(body);
        let reply = { ok: true };
        if (body.op === 'admin-summary') {
          // Redacted shape (the real DO's adminSummaryOp): mode is
          // top-level, and there is NO config (the zone boundary
          // carries lat/lng and is never in an admin summary).
          reply = {
            ok: true,
            room: {
              roomId: ROOM_ID,
              roomCode: 'ABCDEF',
              phase: 'ACTIVE',
              version: 1,
              mode: 'classic',
              startedAt: NOW,
              endsAt: null,
              result: null,
            },
            players: [
              {
                playerId: PLAYER_ID,
                displayName: 'RunnerOne',
                isHost: false,
                matchRole: 'runner',
                team: 'runners',
                connectionState: 'connected',
                lastFixAt: NOW,
                leftAt: null,
                ejectedAt: null,
                isReady: true,
                suspensionCount: 0,
              },
            ],
          };
        } else if (body.op === 'admin-live-fix') {
          reply = { ok: true, fix: { lat: 23.35, lng: 85.33, accuracyMeters: 8, timestampMs: Date.now() } };
        } else if (body.op === 'admin-kick') {
          // Fix round 5 (M3-1 5xx pin): a genuine DO outage must be
          // expressible — when the db carries `doKick5xx`, the kick
          // answers a real HTTP 503 with a body containing NO
          // `status` field, exactly as a real DO op-error body
          // (room-do-class.ts:1261: `json({ok:false, error, code},
          // r.status)` — status is HTTP-only). The old pin carried
          // `status:503` IN the body, which the real DO never emits
          // — the test passed identically against an HTTP-200 stub
          // with the same body, so it pinned nothing. `callDo`
          // propagates the HTTP status into a status-less error
          // body, so the handler sees { ok:false,
          // code:'SERVICE_UNAVAILABLE', status:503 } and must abort
          // the erase (not treat it as "seat already gone").
          if (db?.doKick5xx === true) {
            return new Response(
              JSON.stringify({ ok: false, error: 'Room service unavailable.', code: 'SERVICE_UNAVAILABLE' }),
              { status: 503, headers: { 'Content-Type': 'application/json' } },
            );
          }
          // Fix round M3-1: reproduce the REAL adminKickOp refusals
          // (workers/src/room-do.ts) instead of answering {ok:true}
          // unconditionally — the old stub could never reproduce the
          // 409 that aborted erases of finished rooms. The real DO
          // failure body carries `code` but NO `status`, so the stub
          // omits `status` too (the handler must key on the code).
          // Order mirrors the real op: seat-gone → host → terminal.
          const room = db?.rooms?.find((r) => r.room_id === roomId);
          const seat = db?.players?.find((p) => p.player_id === body.targetPlayerId);
          if (!room) {
            reply = { ok: false, error: 'Room not found.', code: 'ROOM_NOT_FOUND' };
          } else if (!seat || seat.left_at !== null || (seat.ejected_at !== undefined && seat.ejected_at !== null)) {
            reply = { ok: false, error: 'That player is not in the room.', code: 'CONFLICT' };
          } else if (seat.is_host) {
            reply = { ok: false, error: 'The host cannot be kicked — end or cancel the room instead.', code: 'CONFLICT' };
          } else if (['COMPLETED', 'CANCELLED', 'ABANDONED', 'EXPIRED'].includes(room.phase)) {
            reply = { ok: false, error: `Cannot kick from phase ${room.phase}.`, code: 'INVALID_STATE' };
          } else {
            reply = { ok: true, kickedPlayerId: body.targetPlayerId, phase: room.phase };
          }
        } else if (body.op === 'admin-redact-player') {
          // Fix round M3-B: the DO forgets the player (result /
          // config / host → '[erased]' in DO memory). The stub has
          // no DO memory to redact — it answers ok, as the real op
          // does when the id is present (or absent: never a 404).
          reply = { ok: true, redacted: true };
        } else if (body.op === 'admin-end') {
          // Fix round 5 (M3-A): apply the cancel persist the way
          // production does — the real cancel PATCHes the mirror row
          // to phase CANCELLED with the cancelled result
          // (match-result) and upserts it (room-upsert); the row is
          // KEPT as the audit record, never deleted — the "delete"
          // in deleteRoomAfterHostCancel (room-do-class.ts:673-713)
          // wipes DO storage, not the Supabase mirror ("Supabase
          // rows are NOT deleted" in that method's own comment).
          // The erase guard below must therefore see a row state
          // produced by this cancel path (row present, phase
          // CANCELLED), never a hand-set one.
          const row = db?.rooms?.find((r) => r.room_id === roomId);
          if (row) {
            row.phase = 'CANCELLED';
            row.result = { outcome: 'cancelled' };
          }
          reply = { ok: true, phase: 'CANCELLED', result: { outcome: 'cancelled' } };
        } else if (body.op === 'admin-force-results') {
          reply = { ok: true, phase: 'COMPLETED', result: { outcome: 'runners-win' } };
        } else if (body.op === 'add-player') {
          reply = { ok: true, player: { playerId: PLAYER_ID, displayName: 'Joiner' }, reconnectToken: 'new-token', restored: false };
        }
        return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    }),
  };
}

function makeHarness(db, extraEnv = {}) {
  const doCalls = [];
  const pending = [];
  const env = {
    SUPABASE_URL: 'https://sb.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    ADMIN_SESSION_SECRET: 'test-secret',
    ROOM_DO: makeDoStub(doCalls, db),
    CODE_REGISTRY_DO: makeDoStub(doCalls, db),
    ...extraEnv,
  };
  const ctx = {
    env,
    ctx: {
      waitUntil: (p) => {
        pending.push(p);
        p.catch(() => undefined);
      },
    },
  };
  return {
    db,
    env,
    ctx,
    doCalls,
    async flush() {
      await Promise.allSettled(pending);
      pending.length = 0;
    },
  };
}

const PASSWORD_HASH = await hashAdminPassword('password-123');

function seedUsers(db, extra = {}) {
  db.admin_users.push(
    { id: OWNER_ID, username: 'owner', role: 'owner', password_hash: PASSWORD_HASH, created_at: NOW, last_login_at: null, disabled: false, must_change_password: false, ...extra.owner },
    { id: ADMIN_ID, username: 'admin1', role: 'admin', password_hash: PASSWORD_HASH, created_at: NOW, last_login_at: null, disabled: false, must_change_password: false, ...extra.admin },
    { id: STAFF_ID, username: 'staff1', role: 'staff', password_hash: PASSWORD_HASH, created_at: NOW, last_login_at: null, disabled: false, must_change_password: false, ...extra.staff },
  );
}

async function sessionFor(h, userId, expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()) {
  const minted = await mintAdminToken(randomUUID(), 'test-secret');
  h.db.admin_sessions.push({ id: minted.sessionId, user_id: userId, token_hash: minted.tokenHash, expires_at: expiresAt });
  return minted.token;
}

function req(path, { method = 'GET', token = null, body = undefined, ip = null } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (ip) headers['CF-Connecting-IP'] = ip;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    return new Request(`http://worker.test${path}`, { method, headers, body: JSON.stringify(body) });
  }
  return new Request(`http://worker.test${path}`, { method, headers });
}

async function callAdmin(h, handler, r) {
  const res = await handler(r, h.ctx);
  await h.flush();
  return res;
}

function seedLiveRoom(db) {
  db.rooms.push({ room_id: ROOM_ID, room_code: 'ABCDEF', phase: 'ACTIVE', started_at: NOW, ends_at: null, created_at: NOW });
  db.players.push({
    player_id: PLAYER_ID,
    room_id: ROOM_ID,
    display_name: 'RunnerOne',
    kind: 'guest',
    is_host: false,
    match_role: 'runner',
    team: 'runners',
    connection_state: 'connected',
    last_fix_at: NOW,
    left_at: null,
    reconnect_token_hash: 'hash-of-runner-token',
    joined_at: NOW,
  });
}

const HOST_PLAYER_ID = 'ffffffff-6666-4666-8666-666666666666';

/** A second player who IS the room host (for the host-guard tests). */
function seedHostPlayer(db) {
  db.players.push({
    player_id: HOST_PLAYER_ID,
    room_id: ROOM_ID,
    display_name: 'HostOne',
    kind: 'guest',
    is_host: true,
    match_role: null,
    team: null,
    connection_state: 'connected',
    last_fix_at: NOW,
    left_at: null,
    reconnect_token_hash: 'hash-of-host-token',
    joined_at: NOW,
  });
}

// ---------------------------------------------------------------------------
// Auth: login, lockout, sessions, setup
// ---------------------------------------------------------------------------

test('login: correct password mints a session + clears the pair attempts; wrong password 401s + records the pair attempt', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const res = await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', body: { username: 'admin1', password: 'password-123' } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.username, 'admin1');
  assert.equal(body.role, 'admin');
  assert.match(body.token, /^v1\./);
  assert.equal(body.mustChangePassword, false);
  assert.equal(db.admin_sessions.length, 1);
  assert.equal(db.admin_login_attempts.length, 0, 'a successful login leaves no attempt rows');
  const bad = await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', body: { username: 'admin1', password: 'nope-nope-nope' } }));
  assert.equal(bad.status, 401);
  const badBody = await bad.json();
  assert.equal(badBody.code, 'INVALID_CREDENTIALS');
  assert.equal(db.admin_login_attempts.length, 1, 'one failed login records one pair attempt');
  assert.equal(db.admin_login_attempts[0].failed_attempts, 1);
  const unknown = await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', body: { username: 'ghost', password: 'password-123' } }));
  assert.equal(unknown.status, 401, 'unknown username answers the same 401 (no enumeration)');
  assert.equal(db.admin_login_attempts.length, 1, 'unknown usernames do not create attempt rows (no table fill)');
});

test('login lockout is per (account, IP): 5 failures from one IP lock THAT pair (423); the same account from another IP still logs in', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  for (let i = 0; i < 5; i += 1) {
    const r = await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', ip: '203.0.113.10', body: { username: 'admin1', password: 'wrong-password' } }));
    assert.equal(r.status, i === 4 ? 423 : 401, `failure ${i + 1} from the attacker IP`);
  }
  // The locked pair answers 423 even with the RIGHT password.
  const locked = await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', ip: '203.0.113.10', body: { username: 'admin1', password: 'password-123' } }));
  assert.equal(locked.status, 423, 'the locked pair stays locked even with the right password');
  assert.equal((await locked.json()).code, 'ACCOUNT_LOCKED');
  // A DIFFERENT IP is unaffected: the Owner is never locked out of
  // their own IP by an attacker elsewhere.
  const otherIp = await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', ip: '198.51.100.7', body: { username: 'admin1', password: 'password-123' } }));
  assert.equal(otherIp.status, 200, 'a different IP logs in fine while the attacker IP is locked');
  assert.equal(db.admin_login_attempts.length, 1, 'only the attacker pair has a row');
});

test('locked vs wrong-password: the locked path runs the same PBKDF2 work (no timing oracle)', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  // Count PBKDF2 derivations (subtle.deriveBits) across both paths.
  const subtle = globalThis.crypto.subtle;
  const realDeriveBits = subtle.deriveBits.bind(subtle);
  let derivations = 0;
  subtle.deriveBits = (...args) => {
    derivations += 1;
    return realDeriveBits(...args);
  };
  try {
    // One wrong password: exactly one derivation (the real verify).
    await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', ip: '203.0.113.10', body: { username: 'admin1', password: 'wrong-password' } }));
    assert.equal(derivations, 1, 'wrong password costs one PBKDF2');
    // Lock the pair, then try again: the locked path must ALSO cost
    // one derivation (the dummy PBKDF2) — a locked account must not
    // answer faster than a wrong password.
    for (let i = 0; i < 4; i += 1) {
      await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', ip: '203.0.113.10', body: { username: 'admin1', password: 'wrong-password' } }));
    }
    const before = derivations;
    const locked = await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', ip: '203.0.113.10', body: { username: 'admin1', password: 'password-123' } }));
    assert.equal(locked.status, 423);
    assert.equal(derivations - before, 1, 'the locked path runs exactly one dummy PBKDF2 before the 423');
  } finally {
    subtle.deriveBits = realDeriveBits;
  }
});

test('login refuses to mint when ADMIN_SESSION_SECRET is unset and dev mode is off (503)', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db, { ADMIN_SESSION_SECRET: undefined });
  globalThis.fetch = makeFetch(db);
  const res = await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', body: { username: 'admin1', password: 'password-123' } }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'SESSION_SECRET_UNCONFIGURED');
  assert.equal(db.admin_sessions.length, 0, 'no session was minted');
});

test('session expiry + revocation: expired session 401s; logout deletes the session row', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const expiredToken = await sessionFor(h, OWNER_ID, new Date(Date.now() - 1000).toISOString());
  const expired = await callAdmin(h, admin.handleAdminMe, req('/v1/admin/auth/me', { token: expiredToken }));
  assert.equal(expired.status, 401);
  const token = await sessionFor(h, OWNER_ID);
  const me = await callAdmin(h, admin.handleAdminMe, req('/v1/admin/auth/me', { token }));
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { username: 'owner', role: 'owner', mustChangePassword: false });
  assert.equal(db.admin_sessions.length, 1, 'the expired session row was deleted on sight');
  const out = await callAdmin(h, admin.handleAdminLogout, req('/v1/admin/auth/logout', { method: 'POST', token }));
  assert.equal(out.status, 200);
  assert.equal(db.admin_sessions.length, 0, 'logout revokes the session immediately');
  const after = await callAdmin(h, admin.handleAdminMe, req('/v1/admin/auth/me', { token }));
  assert.equal(after.status, 401);
});

test('owner bootstrap: first setup creates the Owner (201); second setup is inert (409)', async () => {
  const db = createDb();
  const h = makeHarness(db, { ADMIN_SETUP_TOKEN: 'founder-secret' });
  globalThis.fetch = makeFetch(db);
  const first = await callAdmin(h, admin.handleAdminSetup, req('/v1/admin/auth/setup', { method: 'POST', body: { username: 'founder', password: 'password-123', setupToken: 'founder-secret' } }));
  assert.equal(first.status, 201);
  const body = await first.json();
  assert.equal(body.role, 'owner');
  assert.match(body.token, /^v1\./);
  assert.equal(db.admin_users.length, 1);
  assert.equal(db.admin_users[0].role, 'owner');
  const second = await callAdmin(h, admin.handleAdminSetup, req('/v1/admin/auth/setup', { method: 'POST', body: { username: 'intruder', password: 'password-123', setupToken: 'founder-secret' } }));
  assert.equal(second.status, 409);
  assert.equal(db.admin_users.length, 1, 'no second account was created');
});

test('setup token: absent OR wrong setupToken 403s when ADMIN_SETUP_TOKEN is set; unset token config refuses setup outright (503)', async () => {
  const db = createDb();
  const h = makeHarness(db, { ADMIN_SETUP_TOKEN: 'founder-secret' });
  globalThis.fetch = makeFetch(db);
  const absent = await callAdmin(h, admin.handleAdminSetup, req('/v1/admin/auth/setup', { method: 'POST', body: { username: 'founder', password: 'password-123' } }));
  assert.equal(absent.status, 403, 'an absent setup token is refused, not allowed with a warning');
  const wrong = await callAdmin(h, admin.handleAdminSetup, req('/v1/admin/auth/setup', { method: 'POST', body: { username: 'founder', password: 'password-123', setupToken: 'wrong' } }));
  assert.equal(wrong.status, 403);
  const absentError = (await absent.json()).error;
  assert.equal((await wrong.json()).error, absentError, 'absent and wrong answer identically (no oracle)');
  // Hardening (fix round re-review): the comparison is constant-time,
  // so wrong tokens of ANY length answer identically — a short token
  // and a much longer token both 403 with the same error, none throws.
  const shortWrong = await callAdmin(h, admin.handleAdminSetup, req('/v1/admin/auth/setup', { method: 'POST', body: { username: 'founder', password: 'password-123', setupToken: 'x' } }));
  assert.equal(shortWrong.status, 403, 'a one-character wrong token 403s identically');
  assert.equal((await shortWrong.json()).error, absentError);
  const longWrong = await callAdmin(h, admin.handleAdminSetup, req('/v1/admin/auth/setup', { method: 'POST', body: { username: 'founder', password: 'password-123', setupToken: 'founder-secret-but-longer-and-wrong' } }));
  assert.equal(longWrong.status, 403, 'a longer wrong token 403s identically');
  assert.equal((await longWrong.json()).error, absentError);
  assert.equal(db.admin_users.length, 0, 'no account was created by any wrong-length token');
  const right = await callAdmin(h, admin.handleAdminSetup, req('/v1/admin/auth/setup', { method: 'POST', body: { username: 'founder', password: 'password-123', setupToken: 'founder-secret' } }));
  assert.equal(right.status, 201);
  // No token configured at all → setup is refused outright (fail closed).
  const db2 = createDb();
  const h2 = makeHarness(db2, { ADMIN_SETUP_TOKEN: undefined });
  globalThis.fetch = makeFetch(db2);
  const unconfigured = await callAdmin(h2, admin.handleAdminSetup, req('/v1/admin/auth/setup', { method: 'POST', body: { username: 'founder', password: 'password-123', setupToken: 'anything' } }));
  assert.equal(unconfigured.status, 503);
  assert.equal((await unconfigured.json()).code, 'SETUP_TOKEN_UNCONFIGURED');
  assert.equal(db2.admin_users.length, 0, 'no account was created without a configured setup token');
});

test('setup race: two concurrent first setups yield exactly one Owner (201 + 409)', async () => {
  const db = createDb();
  const h = makeHarness(db, { ADMIN_SETUP_TOKEN: 'founder-secret' });
  globalThis.fetch = makeFetch(db);
  const body = { username: 'founder', password: 'password-123', setupToken: 'founder-secret' };
  const [a, b] = await Promise.all([
    callAdmin(h, admin.handleAdminSetup, req('/v1/admin/auth/setup', { method: 'POST', body })),
    callAdmin(h, admin.handleAdminSetup, req('/v1/admin/auth/setup', { method: 'POST', body: { ...body, username: 'founder2' } })),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 409], 'one setup wins, the other is inert');
  assert.equal(db.admin_users.length, 1, 'exactly one Owner exists after the race');
});

// ---------------------------------------------------------------------------
// RBAC: every role × the gated endpoints (allowed AND denied)
// ---------------------------------------------------------------------------

test('RBAC sweep: unauthenticated 401s; staff/admin/owner see exactly their matrix', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const adminToken = await sessionFor(h, ADMIN_ID);
  const staffToken = await sessionFor(h, STAFF_ID);

  const anon = await callAdmin(h, admin.handleAdminOverview, req('/v1/admin/overview'));
  assert.equal(anon.status, 401);

  // Users (admin accounts): owner only.
  for (const [token, want] of [[staffToken, 403], [adminToken, 403], [ownerToken, 200]]) {
    const res = await callAdmin(h, admin.handleAdminUsers, req('/v1/admin/users', { token }));
    assert.equal(res.status, want, `GET /users with ${want === 200 ? 'owner' : 'non-owner'}`);
  }
  // Billing reads: owner + admin; staff denied.
  for (const [token, want] of [[staffToken, 403], [adminToken, 200], [ownerToken, 200]]) {
    const res = await callAdmin(h, admin.handleAdminBillingOverview, req('/v1/admin/billing/overview', { token }));
    assert.equal(res.status, want);
  }
  // Flags edit: admin yes, staff no.
  const staffFlags = await callAdmin(h, admin.handleAdminFlagsPut, req('/v1/admin/flags', { method: 'PUT', token: staffToken, body: { flags: [{ key: 'radio', enabled: false }] } }));
  assert.equal(staffFlags.status, 403);
  const adminFlags = await callAdmin(h, admin.handleAdminFlagsPut, req('/v1/admin/flags', { method: 'PUT', token: adminToken, body: { flags: [{ key: 'radio', enabled: false }] } }));
  assert.equal(adminFlags.status, 200);
  assert.equal(db.feature_flags.find((f) => f.key === 'radio').enabled, false);
  const badFlag = await callAdmin(h, admin.handleAdminFlagsPut, req('/v1/admin/flags', { method: 'PUT', token: adminToken, body: { flags: [{ key: 'not-a-flag', enabled: true }] } }));
  assert.equal(badFlag.status, 400, 'unknown flag keys are rejected, never silently added');
  // Room end: staff no, admin yes — and the DO op ran + audit row written.
  const staffEnd = await callAdmin(h, (r, c) => admin.handleAdminRoomAction(r, c, ROOM_ID, 'end'), req(`/v1/admin/rooms/${ROOM_ID}/end`, { method: 'POST', token: staffToken, body: {} }));
  assert.equal(staffEnd.status, 403);
  const adminEnd = await callAdmin(h, (r, c) => admin.handleAdminRoomAction(r, c, ROOM_ID, 'end'), req(`/v1/admin/rooms/${ROOM_ID}/end`, { method: 'POST', token: adminToken, body: {} }));
  assert.equal(adminEnd.status, 200);
  assert.ok(h.doCalls.some((c) => c.op === 'admin-force-results'), 'end drives the REAL DO force-results op');
  assert.ok(db.admin_audit_log.some((a) => a.action === 'admin.rooms.end'), 'room end is audit-logged');
  // Cancel drives admin-end (the delete primitive).
  const adminCancel = await callAdmin(h, (r, c) => admin.handleAdminRoomAction(r, c, ROOM_ID, 'cancel'), req(`/v1/admin/rooms/${ROOM_ID}/cancel`, { method: 'POST', token: adminToken, body: {} }));
  assert.equal(adminCancel.status, 200);
  assert.ok(h.doCalls.some((c) => c.op === 'admin-end'), 'cancel drives the REAL DO admin-end op');
});

test('users endpoints never return password hashes', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const token = await sessionFor(h, OWNER_ID);
  const res = await callAdmin(h, admin.handleAdminUsers, req('/v1/admin/users', { token }));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('password_hash'), 'no password_hash key in the response');
  assert.ok(!text.includes(PASSWORD_HASH.slice(0, 20)), 'no hash material in the response');
  const rows = JSON.parse(text);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['createdAt', 'disabled', 'id', 'role', 'username']);
});

test('last Owner protection: demote, disable and delete all refuse 409', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const token = await sessionFor(h, OWNER_ID);
  const demote = await callAdmin(h, (r, c) => admin.handleAdminUserUpdate(r, c, OWNER_ID), req(`/v1/admin/users/${OWNER_ID}`, { method: 'PUT', token, body: { role: 'admin' } }));
  assert.equal(demote.status, 409);
  const disable = await callAdmin(h, (r, c) => admin.handleAdminUserUpdate(r, c, OWNER_ID), req(`/v1/admin/users/${OWNER_ID}`, { method: 'PUT', token, body: { disabled: true } }));
  assert.equal(disable.status, 409);
  const del = await callAdmin(h, (r, c) => admin.handleAdminUserDelete(r, c, OWNER_ID), req(`/v1/admin/users/${OWNER_ID}`, { method: 'DELETE', token }));
  assert.equal(del.status, 409);
  assert.equal(db.admin_users.length, 3, 'no account was removed');
  // Creating an Admin works, and the new Admin can be deleted again.
  const created = await callAdmin(h, admin.handleAdminUserCreate, req('/v1/admin/users', { method: 'POST', token, body: { username: 'admin2', role: 'admin', password: 'password-123' } }));
  assert.equal(created.status, 201);
  const newId = (await created.json()).id;
  const createOwner = await callAdmin(h, admin.handleAdminUserCreate, req('/v1/admin/users', { method: 'POST', token, body: { username: 'owner2', role: 'owner', password: 'password-123' } }));
  assert.equal(createOwner.status, 400, 'Owner accounts are never created via the users endpoint');
  const delNew = await callAdmin(h, (r, c) => admin.handleAdminUserDelete(r, c, newId), req(`/v1/admin/users/${newId}`, { method: 'DELETE', token }));
  assert.equal(delNew.status, 200);
  // With a second Owner present, deleting or demoting ONE Owner
  // succeeds — the guard protects the LAST Owner, not every Owner
  // (B3: non-last Owners are deletable). The sole Owner is then
  // protected again.
  const OWNER2_ID = '00000000-0000-4000-8000-000000000002';
  db.admin_users.push({ id: OWNER2_ID, username: 'owner2', role: 'owner', password_hash: PASSWORD_HASH, created_at: NOW, last_login_at: null, disabled: false, must_change_password: false });
  const demoteSecond = await callAdmin(h, (r, c) => admin.handleAdminUserUpdate(r, c, OWNER2_ID), req(`/v1/admin/users/${OWNER2_ID}`, { method: 'PUT', token, body: { role: 'admin' } }));
  assert.equal(demoteSecond.status, 200, 'demoting a non-last Owner succeeds');
  const delSecond = await callAdmin(h, (r, c) => admin.handleAdminUserDelete(r, c, OWNER2_ID), req(`/v1/admin/users/${OWNER2_ID}`, { method: 'DELETE', token }));
  assert.equal(delSecond.status, 200, 'deleting a non-last Owner succeeds');
  const delLast = await callAdmin(h, (r, c) => admin.handleAdminUserDelete(r, c, OWNER_ID), req(`/v1/admin/users/${OWNER_ID}`, { method: 'DELETE', token }));
  assert.equal(delLast.status, 409, 'the sole remaining Owner is protected again');
});

test('live location: Owner only — and the audit row never carries coordinates', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const staffToken = await sessionFor(h, STAFF_ID);
  const adminToken = await sessionFor(h, ADMIN_ID);
  const ownerToken = await sessionFor(h, OWNER_ID);
  for (const token of [staffToken, adminToken]) {
    const res = await callAdmin(h, (r, c) => admin.handleAdminPlayerLocation(r, c, PLAYER_ID), req(`/v1/admin/players/${PLAYER_ID}/location`, { token }));
    assert.equal(res.status, 403, 'only the Owner may view an exact live location');
  }
  const res = await callAdmin(h, (r, c) => admin.handleAdminPlayerLocation(r, c, PLAYER_ID), req(`/v1/admin/players/${PLAYER_ID}/location`, { token: ownerToken }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.latitude, 23.35);
  assert.equal(body.longitude, 85.33);
  const audit = db.admin_audit_log.filter((a) => a.action === 'admin.players.locationView');
  assert.equal(audit.length, 1, 'the view is audit-logged');
  const auditText = JSON.stringify(audit[0]);
  assert.ok(!auditText.includes('23.35'), 'audit must never carry the latitude');
  assert.ok(!auditText.includes('85.33'), 'audit must never carry the longitude');
  assert.ok(h.doCalls.some((c) => c.op === 'admin-live-fix'), 'location comes from the live DO, not a stored row');
});

// ---------------------------------------------------------------------------
// Billing + Accounts: flag-OFF not-available, flag-ON stays inert
// ---------------------------------------------------------------------------

test('billing: flag-OFF returns not-available (not an error, not fake data); flag-ON stays inert without a provider', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const adminToken = await sessionFor(h, ADMIN_ID);
  const overview = await callAdmin(h, admin.handleAdminBillingOverview, req('/v1/admin/billing/overview', { token: adminToken }));
  assert.equal(overview.status, 200, 'a flag-OFF read is not an error');
  const off = await overview.json();
  assert.equal(off.available, false);
  assert.equal(off.reason, 'Not available at the moment — future upgrade.');
  assert.equal(off.revenueInr, null, 'no fake revenue');
  assert.deepEqual(off.transactions, []);
  const plans = await callAdmin(h, admin.handleAdminBillingPlans, req('/v1/admin/billing/plans', { token: adminToken }));
  const plansBody = await plans.json();
  assert.equal(plansBody.available, false);
  assert.equal(plansBody.plans.length, 1);
  assert.equal(plansBody.plans[0].name, 'Host Pass');
  assert.equal(plansBody.plans[0].priceLabel, '₹299');
  assert.equal(plansBody.plans[0].status, 'planned');
  assert.match(plansBody.plans[0].statusCopy, /not on sale/);
  // Flip the flags ON: still no provider, still inert, still no fake data.
  // (The flags are cached 60 s per isolate — the test flips the rows
  // directly, so the cache is cleared first, exactly as the PUT
  // handler does.)
  for (const key of ['billing.overview', 'billing.plans', 'billing.transactions']) {
    db.feature_flags.find((f) => f.key === key).enabled = true;
  }
  clearRuntimeFlagCache();
  const on = await (await callAdmin(h, admin.handleAdminBillingOverview, req('/v1/admin/billing/overview', { token: adminToken }))).json();
  assert.equal(on.available, false, 'flag-ON without a provider stays inert');
  assert.match(on.reason, /no payment provider is connected/);
  assert.equal(on.revenueInr, null);
  const tax = await (await callAdmin(h, admin.handleAdminBillingTax, req('/v1/admin/billing/tax', { token: adminToken }))).json();
  assert.equal(tax.available, false);
  assert.deepEqual(tax.invoices, []);
});

test('data-requests + login-methods: flag-OFF not-available; login stays future even with the flag ON', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const token = await sessionFor(h, OWNER_ID);
  const dr = await (await callAdmin(h, admin.handleAdminDataRequests, req('/v1/admin/data-requests', { token }))).json();
  assert.equal(dr.available, false);
  assert.equal(dr.reason, 'Not available at the moment — future upgrade.');
  assert.deepEqual(dr.requests, []);
  const lm = await (await callAdmin(h, admin.handleAdminLoginMethods, req('/v1/admin/login-methods', { token }))).json();
  assert.equal(lm.available, false);
  assert.deepEqual(lm.methods.map((m) => m.method), ['google', 'email']);
  assert.ok(lm.methods.every((m) => m.status === 'future'));
  db.feature_flags.find((f) => f.key === 'accounts.loginMethods').enabled = true;
  clearRuntimeFlagCache();
  const lmOn = await (await callAdmin(h, admin.handleAdminLoginMethods, req('/v1/admin/login-methods', { token }))).json();
  assert.equal(lmOn.available, false, 'the login feature is not built — a flag flip alone cannot make it live');
});

// ---------------------------------------------------------------------------
// Users directory: real guest data + ban/suspend/unban on the seat credential
// ---------------------------------------------------------------------------

test('users-directory: real guest players today; ban blocks the seat credential + kicks live; unban clears', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const staffToken = await sessionFor(h, STAFF_ID);
  const adminToken = await sessionFor(h, ADMIN_ID);
  const list = await callAdmin(h, admin.handleAdminUsersDirectory, req('/v1/admin/users-directory', { token: staffToken }));
  assert.equal(list.status, 200, 'staff may read the directory (view.accounts)');
  const listBody = await list.json();
  assert.equal(listBody.available, true, 'the directory is REAL today, not flag-gated');
  assert.equal(listBody.accountsAvailable, false, 'player accounts do not exist yet');
  assert.equal(listBody.players.length, 1);
  assert.equal(listBody.players[0].codename, 'RunnerOne');
  assert.equal(listBody.players[0].status, 'active');
  assert.ok(!('email' in listBody.players[0]) && !('phone' in listBody.players[0]), 'no invented identity fields');

  const detail = await (await callAdmin(h, (r, c) => admin.handleAdminUsersDirectoryDetail(r, c, PLAYER_ID), req(`/v1/admin/users-directory/${PLAYER_ID}`, { token: adminToken }))).json();
  assert.equal(detail.games.length, 1);
  assert.deepEqual(detail.purchases, [], 'no purchases exist — no provider, no sales');
  assert.equal(detail.player.status, 'active');

  const staffBan = await callAdmin(h, (r, c) => admin.handleAdminDirectoryBan(r, c, PLAYER_ID, 'ban'), req(`/v1/admin/users-directory/${PLAYER_ID}/ban`, { method: 'POST', token: staffToken, body: { reason: 'cheating' } }));
  assert.equal(staffBan.status, 403, 'staff may not ban');
  const ban = await callAdmin(h, (r, c) => admin.handleAdminDirectoryBan(r, c, PLAYER_ID, 'ban'), req(`/v1/admin/users-directory/${PLAYER_ID}/ban`, { method: 'POST', token: adminToken, body: { reason: 'fake GPS' } }));
  assert.equal(ban.status, 200);
  assert.equal(db.blocks.length, 1);
  assert.equal(db.blocks[0].player_id, PLAYER_ID);
  assert.equal(db.blocks[0].reconnect_token_hash, 'hash-of-runner-token', 'the ban binds to the seat credential');
  assert.equal(db.blocks[0].action, 'ban');
  assert.ok(h.doCalls.some((c) => c.op === 'admin-kick'), 'ban kicks the live seat');
  assert.ok(db.admin_audit_log.some((a) => a.action === 'admin.players.ban'), 'ban is audit-logged');
  const detailAfter = await (await callAdmin(h, (r, c) => admin.handleAdminUsersDirectoryDetail(r, c, PLAYER_ID), req(`/v1/admin/users-directory/${PLAYER_ID}`, { token: adminToken }))).json();
  assert.equal(detailAfter.player.status, 'blocked');

  const suspend = await callAdmin(h, (r, c) => admin.handleAdminDirectoryBan(r, c, PLAYER_ID, 'suspend'), req(`/v1/admin/users-directory/${PLAYER_ID}/suspend`, { method: 'POST', token: adminToken, body: { reason: 'spam', suspendDays: 3 } }));
  assert.equal(suspend.status, 200);
  assert.ok(db.blocks.some((b) => b.action === 'suspend' && b.expires_at), 'suspend is time-boxed');
  const unban = await callAdmin(h, (r, c) => admin.handleAdminDirectoryBan(r, c, PLAYER_ID, 'unban'), req(`/v1/admin/users-directory/${PLAYER_ID}/unban`, { method: 'POST', token: adminToken, body: {} }));
  assert.equal(unban.status, 200);
  assert.equal(db.blocks.length, 0, 'unban removes the block rows');
});

test('join gate: a blocked reconnect-token hash cannot rejoin (403); an unblocked token joins', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  const rawToken = 'raw-reconnect-token-1';
  const tokenHash = await sha256Hex(rawToken);
  db.blocks.push({ id: randomUUID(), device_id: PLAYER_ID, player_id: PLAYER_ID, reconnect_token_hash: tokenHash, action: 'ban', reason: 'fake GPS', blocked_by: 'owner', blocked_at: NOW, expires_at: null });
  globalThis.fetch = makeFetch(db);
  const blocked = await http.handleJoin(
    req('/v1/rooms/x/join', { method: 'POST', body: { displayName: 'RunnerOne', kind: 'guest', roomCode: 'ABCDEF', reconnectToken: rawToken } }),
    h.ctx,
    ROOM_ID,
  );
  assert.equal(blocked.status, 403);
  // Expired suspension does not block.
  db.blocks[0].action = 'suspend';
  db.blocks[0].expires_at = new Date(Date.now() - 1000).toISOString();
  const allowed = await http.handleJoin(
    req('/v1/rooms/x/join', { method: 'POST', body: { displayName: 'RunnerOne', kind: 'guest', roomCode: 'ABCDEF', reconnectToken: rawToken } }),
    h.ctx,
    ROOM_ID,
  );
  assert.equal(allowed.status, 200, 'an expired suspension lets the seat rejoin');
});

// ---------------------------------------------------------------------------
// Erasure, public reads, config
// ---------------------------------------------------------------------------

test('erase: Owner-only; player rows go, the admin audit log stays', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  db.catches.push({ catch_id: randomUUID(), room_id: ROOM_ID, hunter_id: PLAYER_ID, runner_id: PLAYER_ID, state: 'confirmed' });
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const adminToken = await sessionFor(h, ADMIN_ID);
  const denied = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, PLAYER_ID), req(`/v1/admin/players/${PLAYER_ID}/erase`, { method: 'POST', token: adminToken, body: {} }));
  assert.equal(denied.status, 403, 'erasure is Owner-only');
  const ownerToken = await sessionFor(h, OWNER_ID);
  const res = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, PLAYER_ID), req(`/v1/admin/players/${PLAYER_ID}/erase`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(res.status, 200);
  assert.equal(db.players.length, 0, 'the player row is gone');
  assert.equal(db.catches.length, 0, 'their catches are gone');
  assert.ok(db.admin_audit_log.some((a) => a.action === 'admin.players.erase'), 'the erase itself is audit-logged');
  assert.ok(db.admin_audit_log.length >= 1, 'the audit log is NOT erased with the player');
});

test('public reads need no auth and fall back to defaults when storage is down', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const flags = await callAdmin(h, admin.handleAdminFlagsPublic, req('/v1/admin/flags/public'));
  assert.equal(flags.status, 200);
  const flagsBody = await flags.json();
  assert.equal(flagsBody.find((f) => f.key === 'radio').enabled, true);
  assert.equal(flags.headers.get('Cache-Control'), 'public, max-age=60');
  const config = await (await callAdmin(h, admin.handleAdminConfigPublic, req('/v1/admin/config/public'))).json();
  assert.equal(config.roundLengthMinutes, 30);
  assert.equal(config.zoneRadiusMetres, 500);
  const noAnnouncement = await (await callAdmin(h, admin.handleAdminAnnouncementsPublic, req('/v1/admin/announcements/public'))).json();
  assert.equal(noAnnouncement, null);
  // Storage down entirely: public reads still answer with defaults.
  const hDown = makeHarness(db, { SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined });
  const downFlags = await callAdmin(hDown, admin.handleAdminFlagsPublic, req('/v1/admin/flags/public'));
  assert.equal(downFlags.status, 200);
  assert.equal((await downFlags.json()).find((f) => f.key === 'radio').enabled, true);
  const downAuthed = await callAdmin(hDown, admin.handleAdminOverview, req('/v1/admin/overview', { token: await sessionFor(hDown, OWNER_ID) }));
  assert.equal(downAuthed.status, 503, 'without storage the admin endpoints fail closed with 503, never a silent empty success');
});

test('config PUT validates against the shared limits', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const token = await sessionFor(h, ADMIN_ID);
  const bad = await callAdmin(h, admin.handleAdminConfigPut, req('/v1/admin/config', { method: 'PUT', token, body: { roundLengthMinutes: 4, headStartMinutes: 3, pingIntervalMinutes: 3, zoneRadiusMetres: 500, shrinkEverySeconds: 600, zoneShrinkEnabled: true } }));
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).issues.some((i) => i.includes('roundLengthMinutes')));
  const good = await callAdmin(h, admin.handleAdminConfigPut, req('/v1/admin/config', { method: 'PUT', token, body: { roundLengthMinutes: 45, headStartMinutes: 3, pingIntervalMinutes: 3, zoneRadiusMetres: 500, shrinkEverySeconds: 600, zoneShrinkEnabled: true } }));
  assert.equal(good.status, 200);
  assert.equal(db.game_config[0].duration_seconds, 2700, 'minutes are stored as seconds (the engine unit)');
  assert.ok(db.admin_audit_log.some((a) => a.action === 'admin.config.edit'));
});

// ---------------------------------------------------------------------------
// Fix round: B3 — Owner containment (password change, session revocation)
// ---------------------------------------------------------------------------

test('B3 change-password is SELF-SERVICE: a flagged Admin is refused on other routes, rotates their own password, flag clears, endpoints work (fix round B3 re-review)', async () => {
  const db = createDb();
  seedUsers(db, { owner: { must_change_password: true }, admin: { must_change_password: true } });
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  // The Owner rotates first (flagged Owner reaches the endpoint too).
  const ownerToken = await sessionFor(h, OWNER_ID);
  const ownerOk = await callAdmin(h, admin.handleAdminChangePassword, req('/v1/admin/auth/change-password', { method: 'POST', token: ownerToken, body: { currentPassword: 'password-123', newPassword: 'owner-new-password-123' } }));
  assert.equal(ownerOk.status, 200, 'a flagged Owner can still rotate via the endpoint');
  assert.equal(db.admin_users.find((u) => u.id === OWNER_ID).must_change_password, false, 'rotation clears the Owner flag');
  // The flagged Admin logs in fine — login must succeed so the
  // client can redirect to the change page — and carries the flag.
  const login = await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', body: { username: 'admin1', password: 'password-123' } }));
  assert.equal(login.status, 200);
  const loginBody = await login.json();
  assert.equal(loginBody.mustChangePassword, true, 'login reports the flag so the client can force rotation');
  const adminToken = loginBody.token;
  // …but every OTHER admin route refuses the flagged session.
  const overview = await callAdmin(h, admin.handleAdminOverview, req('/v1/admin/overview', { token: adminToken }));
  assert.equal(overview.status, 403);
  assert.equal((await overview.json()).code, 'PASSWORD_CHANGE_REQUIRED');
  const players = await callAdmin(h, admin.handleAdminPlayers, req('/v1/admin/players', { token: adminToken }));
  assert.equal(players.status, 403, 'the refusal is not one route — it is every route but change-password and logout');
  assert.equal((await players.json()).code, 'PASSWORD_CHANGE_REQUIRED');
  const me = await callAdmin(h, admin.handleAdminMe, req('/v1/admin/auth/me', { token: adminToken }));
  assert.equal(me.status, 403, '/me refuses a flagged session too');
  // Wrong current password 401s and revokes nothing; a short new
  // password 400s.
  await sessionFor(h, ADMIN_ID);
  assert.equal(db.admin_sessions.filter((s) => s.user_id === ADMIN_ID).length, 2, 'the login session plus the extra session');
  const wrong = await callAdmin(h, admin.handleAdminChangePassword, req('/v1/admin/auth/change-password', { method: 'POST', token: adminToken, body: { currentPassword: 'not-the-password', newPassword: 'brand-new-password-123' } }));
  assert.equal(wrong.status, 401);
  assert.equal(db.admin_sessions.filter((s) => s.user_id === ADMIN_ID).length, 2, 'a failed change revokes nothing');
  const short = await callAdmin(h, admin.handleAdminChangePassword, req('/v1/admin/auth/change-password', { method: 'POST', token: adminToken, body: { currentPassword: 'password-123', newPassword: 'short' } }));
  assert.equal(short.status, 400, 'the new password must meet the 12+ policy');
  // Self-service rotation succeeds and revokes ALL of the caller's
  // sessions, including the one making the call.
  const ok = await callAdmin(h, admin.handleAdminChangePassword, req('/v1/admin/auth/change-password', { method: 'POST', token: adminToken, body: { currentPassword: 'password-123', newPassword: 'brand-new-password-123' } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, reLogin: true });
  assert.equal(db.admin_sessions.filter((s) => s.user_id === ADMIN_ID).length, 0, 'every session for the user is revoked, including the caller’s');
  assert.equal(db.admin_users.find((u) => u.id === ADMIN_ID).must_change_password, false, 'rotation is cleared by the change');
  assert.ok(db.admin_audit_log.some((a) => a.action === 'admin.users.changePassword'), 'the change is audit-logged');
  // The old password no longer works; the new one does — and the
  // flag is clear, so the endpoints work again.
  const oldLogin = await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', body: { username: 'admin1', password: 'password-123' } }));
  assert.equal(oldLogin.status, 401);
  const newLogin = await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', body: { username: 'admin1', password: 'brand-new-password-123' } }));
  assert.equal(newLogin.status, 200);
  const newLoginBody = await newLogin.json();
  assert.equal(newLoginBody.mustChangePassword, false);
  const after = await callAdmin(h, admin.handleAdminOverview, req('/v1/admin/overview', { token: newLoginBody.token }));
  assert.equal(after.status, 200, 'after rotation the endpoints work again');
  // Self-service is OWN password only: there is no target-user
  // parameter to abuse — after the Admin's rotation the Owner's
  // password still works (it was changed above by the Owner only).
  const ownerLogin = await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', body: { username: 'owner', password: 'owner-new-password-123' } }));
  assert.equal(ownerLogin.status, 200, 'nobody else’s password changed');
  // A flagged account can still sign OUT (logout is not refused).
  const db2 = createDb();
  seedUsers(db2, { staff: { must_change_password: true } });
  const h2 = makeHarness(db2);
  globalThis.fetch = makeFetch(db2);
  const staffToken = await sessionFor(h2, STAFF_ID);
  const logout = await callAdmin(h2, admin.handleAdminLogout, req('/v1/admin/auth/logout', { method: 'POST', token: staffToken }));
  assert.equal(logout.status, 200, 'logout keeps working for a flagged account');
  assert.equal(db2.admin_sessions.filter((s) => s.user_id === STAFF_ID).length, 0, 'logout revoked the flagged session');
});

test('B3 revoke-sessions: Owner revokes all of a user’s sessions; Admin 403s; unknown user 404s', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  await sessionFor(h, ADMIN_ID);
  await sessionFor(h, ADMIN_ID);
  await sessionFor(h, STAFF_ID);
  assert.equal(db.admin_sessions.filter((s) => s.user_id === ADMIN_ID).length, 2);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const res = await callAdmin(h, (r, c) => admin.handleAdminRevokeSessions(r, c, ADMIN_ID), req(`/v1/admin/users/${ADMIN_ID}/revoke-sessions`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(res.status, 200);
  assert.equal(db.admin_sessions.filter((s) => s.user_id === ADMIN_ID).length, 0, 'both admin sessions are gone');
  assert.equal(db.admin_sessions.filter((s) => s.user_id === STAFF_ID).length, 1, 'other users’ sessions are untouched');
  assert.ok(db.admin_audit_log.some((a) => a.action === 'admin.users.revokeSessions' && a.target === ADMIN_ID));
  const adminToken = await sessionFor(h, ADMIN_ID);
  const denied = await callAdmin(h, (r, c) => admin.handleAdminRevokeSessions(r, c, STAFF_ID), req(`/v1/admin/users/${STAFF_ID}/revoke-sessions`, { method: 'POST', token: adminToken, body: {} }));
  assert.equal(denied.status, 403, 'an Admin cannot revoke anyone’s sessions');
  const unknown = await callAdmin(h, (r, c) => admin.handleAdminRevokeSessions(r, c, '99999999-9999-4999-8999-999999999999'), req('/v1/admin/users/99999999-9999-4999-8999-999999999999/revoke-sessions', { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(unknown.status, 404);
});

test('B3 disable revokes sessions + Owner password reset forces rotation on next login', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  await sessionFor(h, ADMIN_ID);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const disabled = await callAdmin(h, (r, c) => admin.handleAdminUserUpdate(r, c, ADMIN_ID), req(`/v1/admin/users/${ADMIN_ID}`, { method: 'PUT', token: ownerToken, body: { disabled: true } }));
  assert.equal(disabled.status, 200);
  assert.equal(db.admin_sessions.filter((s) => s.user_id === ADMIN_ID).length, 0, 'disabling deletes the user’s session rows');
  const login = await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', body: { username: 'admin1', password: 'password-123' } }));
  assert.equal(login.status, 401, 'a disabled account cannot log in');
  // Re-enable, then reset the password: the next login reports
  // mustChangePassword so the console can force rotation.
  await callAdmin(h, (r, c) => admin.handleAdminUserUpdate(r, c, ADMIN_ID), req(`/v1/admin/users/${ADMIN_ID}`, { method: 'PUT', token: ownerToken, body: { disabled: false } }));
  const reset = await callAdmin(h, (r, c) => admin.handleAdminUserUpdate(r, c, ADMIN_ID), req(`/v1/admin/users/${ADMIN_ID}`, { method: 'PUT', token: ownerToken, body: { password: 'reset-password-123' } }));
  assert.equal(reset.status, 200);
  assert.equal(db.admin_users.find((u) => u.id === ADMIN_ID).must_change_password, true);
  const afterReset = await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', body: { username: 'admin1', password: 'reset-password-123' } }));
  assert.equal(afterReset.status, 200);
  const afterResetBody = await afterReset.json();
  assert.equal(afterResetBody.mustChangePassword, true, 'the Owner-reset account must rotate on next login');
  // The reset account's session is refused everywhere but the
  // rotation endpoint (B3 re-review) — and self-service rotation
  // clears the flag so the endpoints work again.
  const refused = await callAdmin(h, admin.handleAdminOverview, req('/v1/admin/overview', { token: afterResetBody.token }));
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, 'PASSWORD_CHANGE_REQUIRED');
  const rotated = await callAdmin(h, admin.handleAdminChangePassword, req('/v1/admin/auth/change-password', { method: 'POST', token: afterResetBody.token, body: { currentPassword: 'reset-password-123', newPassword: 'rotated-password-123' } }));
  assert.equal(rotated.status, 200, 'the Owner-reset Admin rotates their own password — no Owner round-trip needed');
  const relogin = await callAdmin(h, admin.handleAdminLogin, req('/v1/admin/auth/login', { method: 'POST', body: { username: 'admin1', password: 'rotated-password-123' } }));
  assert.equal(relogin.status, 200);
  assert.equal((await relogin.json()).mustChangePassword, false);
});

// ---------------------------------------------------------------------------
// Fix round: M1 — public responses strip updatedBy/createdBy
// ---------------------------------------------------------------------------

test('M1 public flags + announcements carry no updatedBy/createdBy', async () => {
  const db = createDb();
  seedUsers(db);
  db.feature_flags[0].updated_by = 'owner';
  db.feature_flags[0].updated_at = NOW;
  db.announcements.push({ id: randomUUID(), text: 'Hello players', active: true, created_by: 'owner', created_at: NOW, updated_at: NOW });
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const flags = await callAdmin(h, admin.handleAdminFlagsPublic, req('/v1/admin/flags/public'));
  assert.equal(flags.status, 200);
  const flagRows = await flags.json();
  assert.ok(flagRows.length > 0);
  for (const f of flagRows) {
    assert.ok(!('updatedBy' in f) && !('updated_by' in f), 'public flags carry no author');
    assert.ok('key' in f && 'enabled' in f && 'label' in f);
  }
  const anns = await callAdmin(h, admin.handleAdminAnnouncementsPublic, req('/v1/admin/announcements/public'));
  assert.equal(anns.status, 200);
  const ann = await anns.json();
  assert.ok(ann && typeof ann === 'object', 'the public endpoint returns the single active announcement');
  assert.ok(!('createdBy' in ann) && !('created_by' in ann), 'public announcements carry no author');
  assert.equal(ann.message, 'Hello players');
  assert.equal(ann.active, true);
  // The authenticated lists still carry the author (auditable).
  const ownerToken = await sessionFor(h, OWNER_ID);
  const authFlags = await callAdmin(h, admin.handleAdminFlags, req('/v1/admin/flags', { token: ownerToken }));
  assert.equal((await authFlags.json())[0].updatedBy, 'owner');
});

// ---------------------------------------------------------------------------
// Fix round: M3 — honest erasure
// ---------------------------------------------------------------------------

test('M3 erase 404s on an unknown playerId — never erased:true for a player that never existed', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const res = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, '99999999-9999-4999-8999-999999999999'), req('/v1/admin/players/99999999-9999-4999-8999-999999999999/erase', { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(res.status, 404);
  assert.equal(db.players.length, 1, 'nothing was deleted');
});

test('M3 erase partial failure is reported honestly (500, deleted + failed lists, erased:false)', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  db.catches.push({ catch_id: randomUUID(), room_id: ROOM_ID, hunter_id: PLAYER_ID, runner_id: PLAYER_ID, state: 'confirmed' });
  const h = makeHarness(db);
  // The catches table delete fails (simulated storage fault).
  globalThis.fetch = makeFetch(db, { failDeleteTables: new Set(['catches']) });
  const ownerToken = await sessionFor(h, OWNER_ID);
  const res = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, PLAYER_ID), req(`/v1/admin/players/${PLAYER_ID}/erase`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.erased, false);
  assert.equal(body.partial, true);
  assert.ok(body.failed.includes('catches.hunter') && body.failed.includes('catches.runner'), 'the failed tables are named');
  assert.ok(body.deleted.includes('players'), 'the tables that did delete are named too');
  assert.ok(db.admin_audit_log.some((a) => a.action === 'admin.players.erase' && String(a.detail).includes('PARTIAL')), 'the partial erasure is audit-logged');
});

test('M3 erase removes game audit_log rows, device_id-keyed blocks and billing rows — admin audit log stays', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  db.audit_log.push(
    { entry_id: randomUUID(), actor_id: PLAYER_ID, action: 'join', room_id: ROOM_ID, target_id: null, result: 'ok', created_at: NOW },
    { entry_id: randomUUID(), actor_id: 'someone-else', action: 'tag', room_id: ROOM_ID, target_id: PLAYER_ID, result: 'ok', created_at: NOW },
  );
  db.blocks.push(
    { id: randomUUID(), device_id: PLAYER_ID, player_id: null, reconnect_token_hash: null, action: 'ban', reason: 'legacy device row', blocked_by: 'owner', blocked_at: NOW, expires_at: null },
    { id: randomUUID(), device_id: 'unrelated-device', player_id: null, reconnect_token_hash: null, action: 'ban', reason: 'other player', blocked_by: 'owner', blocked_at: NOW, expires_at: null },
  );
  db.billing_transactions.push({ id: randomUUID(), player_id: PLAYER_ID, amount_paise: 29900, status: 'planned', created_at: NOW });
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const res = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, PLAYER_ID), req(`/v1/admin/players/${PLAYER_ID}/erase`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.erased, true);
  assert.ok(Array.isArray(body.deleted) && body.deleted.includes('players'));
  assert.equal(db.audit_log.length, 0, 'both game audit_log rows (actor + target) are gone');
  assert.equal(db.blocks.length, 1, 'only the legacy device_id-keyed block for this player is gone');
  assert.equal(db.blocks[0].device_id, 'unrelated-device');
  assert.equal(db.billing_transactions.length, 0, 'billing rows keyed by player_id are gone');
  assert.ok(db.admin_audit_log.some((a) => a.action === 'admin.players.erase'), 'the admin audit log is NOT erased with the player');
});

test('M3 erase scrubs the id from room_events payloads + rooms.result (in place, history kept) and deletes data_requests rows', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  const HUNTER_ID = 'aaaaaaaa-7777-4777-8777-777777777777';
  const OTHER_ID = 'bbbbbbbb-8888-4888-8888-888888888888';
  const matchResult = {
    outcome: 'hunters-win',
    durationSeconds: 600,
    caughtRunnerIds: [PLAYER_ID],
    survivingRunnerIds: [OTHER_ID],
    tags: [{ hunterPlayerId: HUNTER_ID, runnerPlayerId: PLAYER_ID, confirmedAt: NOW }],
  };
  db.room_events.push(
    { event_id: randomUUID(), room_id: ROOM_ID, seq: 1, type: 'PLAYER_TAGGED', actor_id: HUNTER_ID, payload: { catchId: randomUUID(), hunterPlayerId: HUNTER_ID, runnerPlayerId: PLAYER_ID }, created_at: NOW },
    { event_id: randomUUID(), room_id: ROOM_ID, seq: 2, type: 'MATCH_COMPLETED', actor_id: null, payload: { result: matchResult, room: { roomId: ROOM_ID, phase: 'COMPLETED' } }, created_at: NOW },
    { event_id: randomUUID(), room_id: ROOM_ID, seq: 3, type: 'PLAYER_JOINED', actor_id: OTHER_ID, payload: { playerId: OTHER_ID, displayName: 'OtherOne' }, created_at: NOW },
  );
  db.rooms[0].result = matchResult;
  db.data_requests.push({ id: randomUUID(), player_id: PLAYER_ID, kind: 'erasure', contact_ref: null, status: 'received', created_at: NOW, resolved_at: null });
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const res = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, PLAYER_ID), req(`/v1/admin/players/${PLAYER_ID}/erase`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.erased, true);
  assert.ok(body.deleted.includes('room_events.payload'), 'the payload scrub step is reported');
  assert.ok(body.deleted.includes('rooms.result'), 'the rooms.result scrub step is reported');
  assert.ok(body.deleted.includes('data_requests'), 'the data_requests delete step is reported');
  // The id is gone from every JSONB surface…
  assert.equal(JSON.stringify(db.room_events).includes(PLAYER_ID), false, 'no room_events payload still carries the erased id');
  assert.equal(JSON.stringify(db.rooms[0].result).includes(PLAYER_ID), false, 'rooms.result no longer carries the erased id');
  // …but history rows and result shapes survive, redacted in place.
  assert.equal(db.room_events.length, 3, 'no history row was deleted by the scrub');
  const tagged = db.room_events.find((e) => e.type === 'PLAYER_TAGGED');
  assert.equal(tagged.payload.runnerPlayerId, '[erased]');
  assert.equal(tagged.payload.hunterPlayerId, HUNTER_ID, 'other players’ ids are untouched');
  const completed = db.room_events.find((e) => e.type === 'MATCH_COMPLETED');
  assert.deepEqual(completed.payload.result.caughtRunnerIds, ['[erased]']);
  assert.deepEqual(completed.payload.result.survivingRunnerIds, [OTHER_ID]);
  assert.equal(completed.payload.result.tags[0].runnerPlayerId, '[erased]');
  assert.equal(completed.payload.result.tags[0].hunterPlayerId, HUNTER_ID);
  assert.deepEqual(db.rooms[0].result.caughtRunnerIds, ['[erased]']);
  assert.deepEqual(db.rooms[0].result.survivingRunnerIds, [OTHER_ID]);
  const untouched = db.room_events.find((e) => e.type === 'PLAYER_JOINED');
  assert.equal(untouched.payload.playerId, OTHER_ID, 'a payload carrying no erased id is left alone');
  assert.equal(db.data_requests.length, 0, 'data_requests rows for the player are gone');
});

test('M3 erase CAN erase an ex-host of a completed room — the host guard is live-phase only (fix round M3 re-review)', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  db.rooms[0].phase = 'COMPLETED';
  db.rooms[0].result = { outcome: 'runners-win', durationSeconds: 900, caughtRunnerIds: [], survivingRunnerIds: [PLAYER_ID], tags: [] };
  seedHostPlayer(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const erased = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, HOST_PLAYER_ID), req(`/v1/admin/players/${HOST_PLAYER_ID}/erase`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(erased.status, 200, 'the host of a completed room is erasable — "end the room first" is impossible');
  assert.equal((await erased.json()).erased, true);
  assert.equal(db.players.find((p) => p.player_id === HOST_PLAYER_ID), undefined, 'the ex-host row is gone');
  // The live-phase guard still holds (the item-12 test pins the
  // ACTIVE-room case); the boundary is the phase, not the flag.
  const db2 = createDb();
  seedUsers(db2);
  seedLiveRoom(db2);
  seedHostPlayer(db2);
  const h2 = makeHarness(db2);
  globalThis.fetch = makeFetch(db2);
  const ownerToken2 = await sessionFor(h2, OWNER_ID);
  const liveRefused = await callAdmin(h2, (r, c) => admin.handleAdminPlayerErase(r, c, HOST_PLAYER_ID), req(`/v1/admin/players/${HOST_PLAYER_ID}/erase`, { method: 'POST', token: ownerToken2, body: {} }));
  assert.equal(liveRefused.status, 409);
  assert.equal((await liveRefused.json()).code, 'HOST_PROTECTED');
});

test('M3 fix round 3: erase COMPLETES when the DO refuses the kick from a COMPLETED room (409 INVALID_STATE is seat-already-gone, not an abort)', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  db.rooms[0].phase = 'COMPLETED';
  db.rooms[0].result = { outcome: 'runners-win', durationSeconds: 900, caughtRunnerIds: [PLAYER_ID], survivingRunnerIds: [], tags: [] };
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const res = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, PLAYER_ID), req(`/v1/admin/players/${PLAYER_ID}/erase`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(res.status, 200, 'a terminal-phase 409 must not abort the erase — there is no live seat left to kick');
  const body = await res.json();
  assert.equal(body.erased, true);
  assert.equal(body.doRedact, 'ok', 'the DO was still told to forget the player');
  assert.ok(h.doCalls.some((c) => c.op === 'admin-kick'), 'the kick was attempted first');
  assert.ok(h.doCalls.some((c) => c.op === 'admin-redact-player'), 'the DO redact op was invoked during the erase');
  assert.equal(db.players.length, 0, 'the player row is gone');
  assert.deepEqual(db.rooms[0].result.caughtRunnerIds, ['[erased]'], 'the finished room result was still scrubbed');
});

test('M3 fix round 3: erase COMPLETES when the seat already left (409 CONFLICT is seat-already-gone)', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  db.players[0].left_at = NOW;
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const res = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, PLAYER_ID), req(`/v1/admin/players/${PLAYER_ID}/erase`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(res.status, 200, 'an already-left seat must not abort the erase');
  assert.equal((await res.json()).erased, true);
  assert.equal(db.players.length, 0);
});

test('M3 fix round 3: erase nulls rooms.host_player_id and scrubs rooms.config.selectedHunterIds (M3-2 + M3-3)', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  const OTHER_ID = 'bbbbbbbb-8888-4888-8888-888888888888';
  db.rooms[0].phase = 'COMPLETED';
  db.rooms[0].host_player_id = HOST_PLAYER_ID;
  db.rooms[0].config = { mode: 'classic', selectedHunterIds: [HOST_PLAYER_ID, OTHER_ID] };
  db.rooms[0].result = { outcome: 'hunters-win', durationSeconds: 600, caughtRunnerIds: [HOST_PLAYER_ID], survivingRunnerIds: [OTHER_ID], tags: [] };
  seedHostPlayer(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const res = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, HOST_PLAYER_ID), req(`/v1/admin/players/${HOST_PLAYER_ID}/erase`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.erased, true);
  assert.ok(body.deleted.includes('rooms.host_player_id'), 'the host-column nulling is reported as a step');
  assert.ok(body.deleted.includes('rooms.config'), 'the config scrub is reported as a step');
  assert.equal(db.rooms[0].host_player_id, null, 'the erased host id no longer survives in the rooms row');
  assert.deepEqual(db.rooms[0].config.selectedHunterIds, ['[erased]', OTHER_ID], 'selectedHunterIds is redacted in place, other ids untouched');
  assert.deepEqual(db.rooms[0].result.caughtRunnerIds, ['[erased]']);
  assert.equal(JSON.stringify(db.rooms[0]).includes(HOST_PLAYER_ID), false, 'no field of the rooms row still carries the erased id');
  // And a non-host erase claims no host nulling (the step runs only
  // when the mirror row actually names the player).
  const db2 = createDb();
  seedUsers(db2);
  seedLiveRoom(db2);
  db2.rooms[0].phase = 'COMPLETED';
  db2.rooms[0].host_player_id = HOST_PLAYER_ID;
  seedHostPlayer(db2);
  const h2 = makeHarness(db2);
  globalThis.fetch = makeFetch(db2);
  const ownerToken2 = await sessionFor(h2, OWNER_ID);
  const res2 = await callAdmin(h2, (r, c) => admin.handleAdminPlayerErase(r, c, PLAYER_ID), req(`/v1/admin/players/${PLAYER_ID}/erase`, { method: 'POST', token: ownerToken2, body: {} }));
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.equal(body2.erased, true);
  assert.ok(!body2.deleted.includes('rooms.host_player_id'), 'erasing a non-host must not claim a host nulling');
  assert.equal(db2.rooms[0].host_player_id, HOST_PLAYER_ID, 'the real host id is untouched by a non-host erase');
});

test('M3 fix round 3: the erase scrub paginates past the page cap — no silent truncation (M3-4)', async () => {
  const PAGE = admin.ERASE_SCRUB_PAGE_SIZE;
  const OTHER_ID = 'bbbbbbbb-8888-4888-8888-888888888888';
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  // One more row than a page on BOTH scrub surfaces. The events
  // survive the actor delete (actor is someone else) so only the
  // paginated scrub can remove the id from them.
  for (let i = 0; i < PAGE + 1; i += 1) {
    db.room_events.push({ event_id: randomUUID(), room_id: ROOM_ID, seq: 100 + i, type: 'PLAYER_TAGGED', actor_id: OTHER_ID, payload: { runnerPlayerId: PLAYER_ID }, created_at: NOW });
    db.rooms.push({ room_id: randomUUID(), room_code: `R${String(i).padStart(5, '0')}`, phase: 'COMPLETED', started_at: NOW, ends_at: null, created_at: NOW, result: { outcome: 'hunters-win', durationSeconds: 60, caughtRunnerIds: [PLAYER_ID], survivingRunnerIds: [], tags: [] }, config: { mode: 'classic', selectedHunterIds: [PLAYER_ID] } });
  }
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const res = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, PLAYER_ID), req(`/v1/admin/players/${PLAYER_ID}/erase`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.erased, true);
  assert.equal(JSON.stringify(db.room_events).includes(PLAYER_ID), false, 'every event payload past the first page is scrubbed too');
  assert.equal(JSON.stringify(db.rooms).includes(PLAYER_ID), false, 'every room result + config past the first page is scrubbed too');
  assert.equal(db.room_events.filter((e) => e.payload.runnerPlayerId === '[erased]').length, PAGE + 1, 'all seeded events were redacted in place, none dropped');
  assert.equal(db.rooms.filter((r) => Array.isArray(r.config?.selectedHunterIds) && r.config.selectedHunterIds[0] === '[erased]').length, PAGE + 1, 'all seeded room configs were redacted');
});

test('M3 fix round 3: a DRAFT-room host is protected (409 HOST_PROTECTED) — DRAFT counts as live for the host guard (M3-A)', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  db.rooms[0].phase = 'DRAFT';
  seedHostPlayer(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const refused = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, HOST_PLAYER_ID), req(`/v1/admin/players/${HOST_PLAYER_ID}/erase`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(refused.status, 409, 'erasing a DRAFT-room host would orphan a draft that can never start — cancel it first');
  assert.equal((await refused.json()).code, 'HOST_PROTECTED');
  assert.ok(db.players.some((p) => p.player_id === HOST_PLAYER_ID), 'no player row was deleted');
  // Once the draft ends (COMPLETED here), the same host is erasable.
  db.rooms[0].phase = 'COMPLETED';
  const erased = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, HOST_PLAYER_ID), req(`/v1/admin/players/${HOST_PLAYER_ID}/erase`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(erased.status, 200);
  assert.equal((await erased.json()).erased, true);
});

test('M3-A fix round 5: the cancel→erase chain end-to-end — admin cancel a DRAFT room, then erase its host', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  db.rooms[0].phase = 'DRAFT';
  seedHostPlayer(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  // The chain the Owner is told to use: cancel first (the 409 above
  // is only the guard, not the path). Cancel goes through the real
  // handler + the DO stub's admin-end.
  const cancelled = await callAdmin(h, (r, c) => admin.handleAdminRoomAction(r, c, ROOM_ID, 'cancel'), req(`/v1/admin/rooms/${ROOM_ID}/cancel`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(cancelled.status, 200, 'admin cancel of the DRAFT room completes');
  assert.equal((await cancelled.json()).phase, 'CANCELLED');
  assert.ok(h.doCalls.some((c) => c.op === 'admin-end'), 'the cancel reached the DO as admin-end');
  // The cancel's own persist landed the mirror row: the stub's
  // admin-end applies the production match-result PATCH +
  // room-upsert (phase CANCELLED, result cancelled) to the stub
  // mirror row, so the erase below sees a row state produced by
  // the cancel path under test — nothing is hand-set here. (Fix
  // round 5: the old hand-set `db.rooms[0].phase = 'CANCELLED'`
  // faked exactly this landing, so a cancel whose persist failed
  // could never be caught. And the row is NOT deleted by a cancel
  // — production keeps it as the audit record; the erase guard
  // takes the "row present, phase CANCELLED" branch, not the
  // missing-row branch.)
  assert.equal(db.rooms.length, 1, 'the cancel keeps the mirror row as the audit record — it never deletes it');
  assert.equal(db.rooms[0].phase, 'CANCELLED', 'the cancel persist landed the phase');
  assert.equal(db.rooms[0].result?.outcome, 'cancelled', 'the cancel persist landed the result');
  const erased = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, HOST_PLAYER_ID), req(`/v1/admin/players/${HOST_PLAYER_ID}/erase`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(erased.status, 200, 'after the cancel, the ex-host erases');
  assert.equal((await erased.json()).erased, true);
  assert.equal(db.players.find((p) => p.player_id === HOST_PLAYER_ID), undefined, 'the ex-host row is gone');
});

test('M3-1 fix round 5: a genuine 5xx kick failure ABORTS the erase (the 503 is not "seat already gone")', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  // The DO is down: every admin-kick answers a real HTTP 503 with a
  // status-less body (see the stub note above).
  db.doKick5xx = true;
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  // One event row, authored BY the player being erased: the erase's
  // scrub would delete it if it ever ran, so asserting it survives
  // proves the abort happened before any scrub step (the old
  // `room_events.length === 0` assertion was vacuous — with no rows
  // seeded, nothing could have run and it still passed).
  db.room_events.push({ event_id: randomUUID(), room_id: ROOM_ID, seq: 1, type: 'PLAYER_JOINED', actor_id: PLAYER_ID, payload: { playerId: PLAYER_ID, displayName: 'RunnerOne' }, created_at: NOW });
  const res = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, PLAYER_ID), req(`/v1/admin/players/${PLAYER_ID}/erase`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(res.status, 503, 'a genuine DO outage aborts with 503, it must never be swallowed as a 409-tolerant seat-gone');
  const body = await res.json();
  assert.notEqual(body.erased, true, 'nothing may report erased:true on an aborted erase');
  assert.equal(db.players.length, 1, 'no player row was deleted');
  assert.equal(db.players[0].player_id, PLAYER_ID);
  assert.equal(db.room_events.length, 1, 'no scrub step ran after the abort — the seeded event row survives');
  assert.equal(db.room_events[0].actor_id, PLAYER_ID, 'the surviving event row is untouched');
  assert.ok(h.doCalls.some((c) => c.op === 'admin-kick'), 'the kick was attempted');
  assert.ok(!h.doCalls.some((c) => c.op === 'admin-redact-player'), 'the redact never ran after the abort');
});

test('M3-4 fix round 4: the erase scrub uses keyset pagination — a concurrent delete mid-scrub skips no row', async () => {
  const PAGE = admin.ERASE_SCRUB_PAGE_SIZE;
  const OTHER_ID = 'bbbbbbbb-8888-4888-8888-888888888888';
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  // One more row than a page on BOTH scrub surfaces. The events
  // survive the actor delete (actor is someone else) so only the
  // paginated scrub can remove the id from them.
  for (let i = 0; i < PAGE + 1; i += 1) {
    db.room_events.push({ event_id: randomUUID(), room_id: ROOM_ID, seq: 100 + i, type: 'PLAYER_TAGGED', actor_id: OTHER_ID, payload: { runnerPlayerId: PLAYER_ID }, created_at: NOW });
    db.rooms.push({ room_id: randomUUID(), room_code: `R${String(i).padStart(5, '0')}`, phase: 'COMPLETED', started_at: NOW, ends_at: null, created_at: NOW, result: { outcome: 'hunters-win', durationSeconds: 60, caughtRunnerIds: [PLAYER_ID], survivingRunnerIds: [], tags: [] }, config: { mode: 'classic', selectedHunterIds: [PLAYER_ID] } });
  }
  const h = makeHarness(db);
  // A concurrent DELETE lands mid-scrub: on the SECOND page GET for
  // each scrubbed table, one already-visited row is deleted first.
  // Under the old offset pagination that deletion shifted every later
  // row up one and the boundary row was skipped (residue reported as
  // erased:true); under keyset pagination the cursor is unaffected
  // and every surviving row is still visited exactly once.
  const baseFetch = makeFetch(db);
  let eventPageGets = 0;
  let roomPageGets = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/room_events') && u.includes('select=event_id')) {
      eventPageGets += 1;
      if (eventPageGets === 2) db.room_events.splice(0, 1);
    }
    if (u.includes('/rooms') && u.includes('select=room_id,result,config')) {
      roomPageGets += 1;
      if (roomPageGets === 2) db.rooms.splice(1, 1);
    }
    return baseFetch(url, init);
  };
  const ownerToken = await sessionFor(h, OWNER_ID);
  const res = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, PLAYER_ID), req(`/v1/admin/players/${PLAYER_ID}/erase`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.erased, true);
  assert.ok(eventPageGets >= 2, 'the events scrub really paged (the race was exercised)');
  assert.ok(roomPageGets >= 2, 'the rooms scrub really paged (the race was exercised)');
  assert.equal(JSON.stringify(db.room_events).includes(PLAYER_ID), false, 'every surviving event payload past the first page is scrubbed too, despite the mid-scrub delete');
  assert.equal(JSON.stringify(db.rooms).includes(PLAYER_ID), false, 'every surviving room result + config past the first page is scrubbed too, despite the mid-scrub delete');
  assert.equal(db.room_events.filter((e) => e.payload.runnerPlayerId === '[erased]').length, PAGE, 'all surviving seeded events were redacted in place (one was deleted mid-scrub, none skipped)');
  assert.equal(db.rooms.filter((r) => Array.isArray(r.config?.selectedHunterIds) && r.config.selectedHunterIds[0] === '[erased]').length, PAGE, 'all surviving seeded room configs were redacted (one was deleted mid-scrub, none skipped)');
});

test('M4 fix round 3: data-requests flag-ON list read is audit-logged (count only, never row data)', async () => {
  const db = createDb();
  seedUsers(db);
  db.data_requests.push(
    { id: randomUUID(), player_id: PLAYER_ID, kind: 'erasure', contact_ref: 'contact-AAA-1', status: 'received', created_at: NOW, resolved_at: null },
    { id: randomUUID(), player_id: 'bbbbbbbb-8888-4888-8888-888888888888', kind: 'access', contact_ref: 'contact-AAA-2', status: 'received', created_at: NOW, resolved_at: null },
  );
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const token = await sessionFor(h, OWNER_ID);
  db.feature_flags.find((f) => f.key === 'accounts.dataRequests').enabled = true;
  clearRuntimeFlagCache();
  const res = await callAdmin(h, admin.handleAdminDataRequests, req('/v1/admin/data-requests', { token }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, true);
  assert.equal(body.requests.length, 2);
  const row = db.admin_audit_log.find((a) => a.action === 'admin.dataRequests.listRead');
  assert.ok(row, 'the flag-ON list read leaves an audit row');
  assert.match(String(row.detail), /2/, 'the trail carries the count');
  assert.ok(!String(row.detail).includes('contact-AAA-1') && !String(row.detail).includes('contact-AAA-2'), 'the trail carries no contact refs');
  assert.ok(!String(row.detail).includes(PLAYER_ID), 'the trail carries no player ids');
});

test('M4 fix round 3: room detail read is audit-logged (player count only, never ids or codenames)', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const adminToken = await sessionFor(h, ADMIN_ID);
  const res = await callAdmin(h, (r, c) => admin.handleAdminRoomDetail(r, c, ROOM_ID), req(`/v1/admin/rooms/${ROOM_ID}`, { token: adminToken }));
  assert.equal(res.status, 200, 'the detail read itself still works');
  const body = await res.json();
  assert.equal(body.playersList.length, 1, 'the roster is still returned in full');
  const row = db.admin_audit_log.find((a) => a.action === 'admin.rooms.detailRead');
  assert.ok(row, 'the roster-returning detail read leaves an audit row');
  assert.equal(row.target, ROOM_ID);
  assert.match(String(row.detail), /1 players listed/, 'the trail carries the player count');
  assert.ok(!String(row.detail).includes(PLAYER_ID), 'the trail carries no player ids');
  assert.ok(!String(row.detail).includes('RunnerOne'), 'the trail carries no codenames');
});

// ---------------------------------------------------------------------------
// Fix round: M4 — audit-write failure visibility
// ---------------------------------------------------------------------------

test('M4 a failed audit insert is logged loudly + counted in the health signal (never silently lost)', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db, { failInsertTables: new Set(['admin_audit_log']) });
  const before = admin.getAuditHealth().writeFailures;
  const errors = [];
  const realError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    const ownerToken = await sessionFor(h, OWNER_ID);
    const res = await callAdmin(h, admin.handleAdminFlagsPut, req('/v1/admin/flags', { method: 'PUT', token: ownerToken, body: { flags: [{ key: 'radio', enabled: false }] } }));
    assert.equal(res.status, 200, 'the flag write itself still succeeds');
  } finally {
    console.error = realError;
  }
  assert.ok(admin.getAuditHealth().writeFailures > before, 'the health counter moved');
  assert.ok(admin.getAuditHealth().lastWriteFailureAt, 'the health signal carries a timestamp');
  assert.ok(errors.some((e) => e.includes('audit')), 'the failure was logged loudly via console.error');
  assert.equal(db.admin_audit_log.length, 0, 'no audit row was written (the failure is real, not swallowed)');
});

// ---------------------------------------------------------------------------
// Fix round: M6 — future flags are flippable (Owner-only)
// ---------------------------------------------------------------------------

test('M6 future flags: Owner flips billing.accounts keys (200); Admin gets 403; unknown keys still 400', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const adminToken = await sessionFor(h, ADMIN_ID);
  const ownerPut = await callAdmin(h, admin.handleAdminFlagsPut, req('/v1/admin/flags', { method: 'PUT', token: ownerToken, body: { flags: [{ key: 'billing.overview', enabled: true }] } }));
  assert.equal(ownerPut.status, 200, 'the flag-flip activation story is true for the Owner');
  assert.equal(db.feature_flags.find((f) => f.key === 'billing.overview').enabled, true);
  const adminPut = await callAdmin(h, admin.handleAdminFlagsPut, req('/v1/admin/flags', { method: 'PUT', token: adminToken, body: { flags: [{ key: 'billing.overview', enabled: false }] } }));
  assert.equal(adminPut.status, 403, 'an Admin flipping a future flag would silently activate a section the Owner has not approved');
  const gamePut = await callAdmin(h, admin.handleAdminFlagsPut, req('/v1/admin/flags', { method: 'PUT', token: adminToken, body: { flags: [{ key: 'radio', enabled: false }] } }));
  assert.equal(gamePut.status, 200, 'game flags stay Admin-flippable');
  const unknown = await callAdmin(h, admin.handleAdminFlagsPut, req('/v1/admin/flags', { method: 'PUT', token: ownerToken, body: { flags: [{ key: 'not.a.flag', enabled: true }] } }));
  assert.equal(unknown.status, 400);
});

// ---------------------------------------------------------------------------
// Fix round, 2026-11-27 — duplicate flag keys are rejected (400) before
// any write. Before this, both entries were applied in order and the
// audit row logged both (`billing.overview=on, billing.overview=off`)
// — a misleading trail that hid which value actually stuck.
// ---------------------------------------------------------------------------

test('M6c PUT /v1/admin/flags with a duplicate key → 400, nothing written, no audit row', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const dup = await callAdmin(h, admin.handleAdminFlagsPut, req('/v1/admin/flags', { method: 'PUT', token: ownerToken, body: { flags: [{ key: 'radio', enabled: false }, { key: 'radio', enabled: true }] } }));
  assert.equal(dup.status, 400, 'a repeated flag key is rejected like an unknown key');
  assert.equal(db.feature_flags.find((f) => f.key === 'radio').enabled, true, 'neither duplicate entry was applied');
  assert.equal(db.admin_audit_log.filter((r) => r.action === 'admin.flags.edit').length, 0, 'no audit row logs the refused write');
  // The same key twice with the SAME value is still a duplicate.
  const dupSame = await callAdmin(h, admin.handleAdminFlagsPut, req('/v1/admin/flags', { method: 'PUT', token: ownerToken, body: { flags: [{ key: 'radio', enabled: false }, { key: 'radio', enabled: false }] } }));
  assert.equal(dupSame.status, 400);
  assert.equal(db.feature_flags.find((f) => f.key === 'radio').enabled, true, 'still nothing written');
});

// ---------------------------------------------------------------------------
// Merge (2026-11-27, Meera fix 1) — GET /v1/admin/flags returns the
// future flags too, so the flags page can list/flip them and the
// billing/accounts pages can read their live state. Before this,
// GET returned game flags ONLY while PUT already accepted future
// keys — the flip mechanism existed but no client could ever see
// or use it, and every billing/accounts section rendered
// NotAvailable from the static defs.
// ---------------------------------------------------------------------------

test('M6b GET /v1/admin/flags lists future flags (default OFF) and reflects an Owner flip', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const before = await callAdmin(h, admin.handleAdminFlags, req('/v1/admin/flags', { token: ownerToken }));
  assert.equal(before.status, 200);
  const rows = await before.json();
  // 7 game flags + 11 future flags.
  assert.equal(rows.length, 18, 'GET flags returns game + future rows');
  const gameKeys = rows.filter((f) => !f.key.includes('.')).map((f) => f.key);
  assert.ok(gameKeys.includes('gameStart'), 'gameStart stays listed');
  for (const key of ['billing.overview', 'billing.transactions', 'billing.plans', 'billing.providers', 'billing.refunds', 'billing.tax', 'accounts.directory', 'accounts.roles', 'accounts.bans', 'accounts.dataRequests', 'accounts.loginMethods']) {
    const row = rows.find((f) => f.key === key);
    assert.ok(row, `GET flags lists ${key}`);
    assert.equal(row.enabled, false, `${key} defaults OFF`);
    assert.ok(typeof row.label === 'string' && row.label.length > 0, `${key} carries a label for the flags page`);
  }
  // Owner flips one; GET reflects it (the flags page toggle path).
  const put = await callAdmin(h, admin.handleAdminFlagsPut, req('/v1/admin/flags', { method: 'PUT', token: ownerToken, body: { flags: [{ key: 'billing.overview', enabled: true }] } }));
  assert.equal(put.status, 200);
  const after = await callAdmin(h, admin.handleAdminFlags, req('/v1/admin/flags', { token: ownerToken }));
  const flipped = (await after.json()).find((f) => f.key === 'billing.overview');
  assert.equal(flipped.enabled, true, 'the flipped future flag reads back ON');
  // The PUBLIC flags read stays game-only: future-flag activation
  // state is admin-internal, not game-client data.
  const pub = await callAdmin(h, admin.handleAdminFlagsPublic, req('/v1/admin/flags/public'));
  const pubRows = await pub.json();
  assert.ok(pubRows.length === 7, 'public flags carry game flags only');
  assert.ok(!pubRows.some((f) => f.key.includes('.')), 'no future flag leaks into the public read');
});

// ---------------------------------------------------------------------------
// Fix round: M5 + item 12 — ban honesty + host protection
// ---------------------------------------------------------------------------

test('M5 safety blocks: arbitrary deviceId 400s; a real playerId blocks by seat credential (enforcement: seat-credential)', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const arbitrary = await callAdmin(h, admin.handleAdminSafetyBlockCreate, req('/v1/admin/safety/blocks', { method: 'POST', token: ownerToken, body: { deviceId: 'some-arbitrary-device-key', reason: 'cheating' } }));
  assert.equal(arbitrary.status, 400, 'there is no device key in the game, so an arbitrary deviceId cannot be blocked');
  assert.equal(db.blocks.length, 0);
  const unknown = await callAdmin(h, admin.handleAdminSafetyBlockCreate, req('/v1/admin/safety/blocks', { method: 'POST', token: ownerToken, body: { playerId: '99999999-9999-4999-8999-999999999999', reason: 'cheating' } }));
  assert.equal(unknown.status, 404);
  const ok = await callAdmin(h, admin.handleAdminSafetyBlockCreate, req('/v1/admin/safety/blocks', { method: 'POST', token: ownerToken, body: { playerId: PLAYER_ID, reason: 'fake GPS' } }));
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.equal(body.enforcement, 'seat-credential', 'the response says what the ban actually binds to');
  assert.equal(body.liveKick, 'ok');
  assert.equal(db.blocks.length, 1);
  assert.equal(db.blocks[0].reconnect_token_hash, 'hash-of-runner-token', 'the block binds to the seat credential');
  assert.equal(db.blocks[0].player_id, PLAYER_ID);
  assert.ok(h.doCalls.some((c) => c.op === 'admin-kick'), 'the live seat was kicked out of the room');
  // Deleting by playerId removes the block (player_id AND legacy device_id rows).
  const del = await callAdmin(h, (r, c) => admin.handleAdminSafetyBlockDelete(r, c, PLAYER_ID), req(`/v1/admin/safety/blocks/${PLAYER_ID}`, { method: 'DELETE', token: ownerToken }));
  assert.equal(del.status, 200);
  assert.equal(db.blocks.length, 0);
});

test('item 12 host protection: block / directory-ban / erase refuse 409 HOST_PROTECTED on the room host', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  seedHostPlayer(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const blocked = await callAdmin(h, admin.handleAdminSafetyBlockCreate, req('/v1/admin/safety/blocks', { method: 'POST', token: ownerToken, body: { playerId: HOST_PLAYER_ID, reason: 'host misbehaving' } }));
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, 'HOST_PROTECTED');
  assert.equal(db.blocks.length, 0, 'no block row was written for the host');
  const banned = await callAdmin(h, (r, c) => admin.handleAdminDirectoryBan(r, c, HOST_PLAYER_ID, 'ban'), req(`/v1/admin/users-directory/${HOST_PLAYER_ID}/ban`, { method: 'POST', token: ownerToken, body: { reason: 'host misbehaving' } }));
  assert.equal(banned.status, 409);
  assert.equal(db.blocks.length, 0, 'no ban row was written for the host');
  const erased = await callAdmin(h, (r, c) => admin.handleAdminPlayerErase(r, c, HOST_PLAYER_ID), req(`/v1/admin/players/${HOST_PLAYER_ID}/erase`, { method: 'POST', token: ownerToken, body: {} }));
  assert.equal(erased.status, 409);
  assert.equal(db.players.length, 2, 'no player row was deleted');
  assert.ok(db.admin_audit_log.some((a) => a.action === 'admin.players.erase' && String(a.detail).includes('refused')), 'the refusal is audit-logged');
});

// ---------------------------------------------------------------------------
// Fix round: item 9 — unblock is gated on players.unblock (proven via the
// denial audit action) + metrics is gated on view.costs
// ---------------------------------------------------------------------------

test('item 9 unblock denial is audited as admin.players.unblock (not players.block); metrics requires view.costs', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const staffToken = await sessionFor(h, STAFF_ID);
  const unblock = await callAdmin(h, (r, c) => admin.handleAdminPlayerAction(r, c, PLAYER_ID, 'unblock'), req(`/v1/admin/players/${PLAYER_ID}/unblock`, { method: 'POST', token: staffToken, body: {} }));
  assert.equal(unblock.status, 403);
  assert.ok(
    db.admin_audit_log.some((a) => a.action === 'admin.players.unblock' && String(a.detail).includes('denied')),
    'the denial names the permission actually checked',
  );
  const metrics = await callAdmin(h, admin.handleAdminMetrics, req('/v1/admin/metrics', { token: staffToken }));
  assert.equal(metrics.status, 200, 'staff holds view.costs today (all roles do) — the gate exists and is exercised');
});

// ---------------------------------------------------------------------------
// Fix round: item 10 — bulk list reads leave an audit trail
// ---------------------------------------------------------------------------

test('item 10 bulk reads are audit-logged (players, rooms, audit, directory — plus overview, safety, users, announcements, flags, metrics) with row counts only', async () => {
  const db = createDb();
  seedUsers(db);
  seedLiveRoom(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const adminToken = await sessionFor(h, ADMIN_ID);
  const ownerToken = await sessionFor(h, OWNER_ID);
  await callAdmin(h, admin.handleAdminPlayers, req('/v1/admin/players', { token: adminToken }));
  await callAdmin(h, admin.handleAdminRooms, req('/v1/admin/rooms', { token: adminToken }));
  await callAdmin(h, admin.handleAdminAudit, req('/v1/admin/audit', { token: adminToken }));
  await callAdmin(h, admin.handleAdminUsersDirectory, req('/v1/admin/users-directory', { token: adminToken }));
  // M4 re-review: the six lists the first pin never called.
  await callAdmin(h, admin.handleAdminOverview, req('/v1/admin/overview', { token: adminToken }));
  await callAdmin(h, admin.handleAdminSafety, req('/v1/admin/safety', { token: adminToken }));
  await callAdmin(h, admin.handleAdminUsers, req('/v1/admin/users', { token: ownerToken }));
  await callAdmin(h, admin.handleAdminAnnouncements, req('/v1/admin/announcements', { token: adminToken }));
  await callAdmin(h, admin.handleAdminFlags, req('/v1/admin/flags', { token: adminToken }));
  await callAdmin(h, admin.handleAdminMetrics, req('/v1/admin/metrics', { token: adminToken }));
  for (const action of ['admin.players.listRead', 'admin.rooms.listRead', 'admin.audit.listRead', 'admin.accounts.listRead', 'admin.overview.listRead', 'admin.safety.listRead', 'admin.users.listRead', 'admin.announcements.listRead', 'admin.flags.listRead', 'admin.metrics.listRead']) {
    assert.ok(db.admin_audit_log.some((a) => a.action === action), `bulk read ${action} is audit-logged`);
  }
  const readRow = db.admin_audit_log.find((a) => a.action === 'admin.players.listRead');
  assert.ok(!String(readRow.detail).includes('RunnerOne'), 'the trail carries a row count, never row data');
  const safetyRow = db.admin_audit_log.find((a) => a.action === 'admin.safety.listRead');
  assert.match(String(safetyRow.detail), /bulk read:/, 'the safety trail carries counts only');
  const usersRow = db.admin_audit_log.find((a) => a.action === 'admin.users.listRead');
  assert.ok(!String(usersRow.detail).includes('admin1') && !String(usersRow.detail).includes('owner'), 'the users trail carries a count, never usernames');
});

// ---------------------------------------------------------------------------
// Fix round: item 13 — empty patch 400 + Cache-Control: no-store on the
// authenticated admin JSON (via the router in index.ts)
// ---------------------------------------------------------------------------

test('item 13 empty user-update patch 400s; password reset via PUT is a real update', async () => {
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const empty = await callAdmin(h, (r, c) => admin.handleAdminUserUpdate(r, c, ADMIN_ID), req(`/v1/admin/users/${ADMIN_ID}`, { method: 'PUT', token: ownerToken, body: {} }));
  assert.equal(empty.status, 400);
  const reset = await callAdmin(h, (r, c) => admin.handleAdminUserUpdate(r, c, ADMIN_ID), req(`/v1/admin/users/${ADMIN_ID}`, { method: 'PUT', token: ownerToken, body: { password: 'reset-password-123' } }));
  assert.equal(reset.status, 200);
});

test('item 13 Cache-Control: no-store on authenticated admin JSON; public reads keep their own public cache header', async () => {
  const worker = await import('../src/index.ts');
  const db = createDb();
  seedUsers(db);
  const h = makeHarness(db);
  globalThis.fetch = makeFetch(db);
  const ownerToken = await sessionFor(h, OWNER_ID);
  const pending = [];
  const ctx = { waitUntil: (p) => { pending.push(p); } };
  const authRes = await worker.default.fetch(req('/v1/admin/overview', { token: ownerToken }), h.env, ctx);
  await Promise.allSettled(pending);
  assert.equal(authRes.status, 200);
  assert.equal(authRes.headers.get('Cache-Control'), 'no-store', 'authenticated admin JSON must never sit in a cache');
  const publicRes = await worker.default.fetch(req('/v1/admin/flags/public'), h.env, ctx);
  await Promise.allSettled(pending);
  assert.equal(publicRes.status, 200);
  assert.match(publicRes.headers.get('Cache-Control') ?? '', /public/, 'public reads keep their own cache header');
});

// ---------------------------------------------------------------------------
// Fix round: item 14 — RBAC sweep over EVERY gated endpoint × every role
// ---------------------------------------------------------------------------

test('item 14 RBAC sweep: every handler × owner/admin/staff matches the shared matrix exactly', async () => {
  const sweep = [
    { name: 'overview', permission: 'view.overview', call: (h, t) => admin.handleAdminOverview(req('/v1/admin/overview', { token: t }), h.ctx) },
    { name: 'rooms list', permission: 'view.rooms', call: (h, t) => admin.handleAdminRooms(req('/v1/admin/rooms', { token: t }), h.ctx) },
    { name: 'room detail', permission: 'view.rooms', call: (h, t) => admin.handleAdminRoomDetail(req(`/v1/admin/rooms/${ROOM_ID}`, { token: t }), h.ctx, ROOM_ID) },
    { name: 'room end', permission: 'rooms.end', call: (h, t) => admin.handleAdminRoomAction(req(`/v1/admin/rooms/${ROOM_ID}/end`, { method: 'POST', token: t, body: {} }), h.ctx, ROOM_ID, 'end') },
    { name: 'room cancel', permission: 'rooms.cancel', call: (h, t) => admin.handleAdminRoomAction(req(`/v1/admin/rooms/${ROOM_ID}/cancel`, { method: 'POST', token: t, body: {} }), h.ctx, ROOM_ID, 'cancel') },
    { name: 'room force-results', permission: 'rooms.forceResults', call: (h, t) => admin.handleAdminRoomAction(req(`/v1/admin/rooms/${ROOM_ID}/force-results`, { method: 'POST', token: t, body: {} }), h.ctx, ROOM_ID, 'force-results') },
    { name: 'players list', permission: 'view.players', call: (h, t) => admin.handleAdminPlayers(req('/v1/admin/players', { token: t }), h.ctx) },
    { name: 'player location', permission: 'players.viewLocation', call: (h, t) => admin.handleAdminPlayerLocation(req(`/v1/admin/players/${PLAYER_ID}/location`, { token: t }), h.ctx, PLAYER_ID) },
    { name: 'player kick', permission: 'players.kick', call: (h, t) => admin.handleAdminPlayerAction(req(`/v1/admin/players/${PLAYER_ID}/kick`, { method: 'POST', token: t, body: {} }), h.ctx, PLAYER_ID, 'kick') },
    { name: 'player block', permission: 'players.block', call: (h, t) => admin.handleAdminPlayerAction(req(`/v1/admin/players/${PLAYER_ID}/block`, { method: 'POST', token: t, body: {} }), h.ctx, PLAYER_ID, 'block') },
    { name: 'player unblock', permission: 'players.unblock', call: (h, t) => admin.handleAdminPlayerAction(req(`/v1/admin/players/${PLAYER_ID}/unblock`, { method: 'POST', token: t, body: {} }), h.ctx, PLAYER_ID, 'unblock') },
    { name: 'player erase', permission: 'players.erase', call: (h, t) => admin.handleAdminPlayerErase(req(`/v1/admin/players/${PLAYER_ID}/erase`, { method: 'POST', token: t, body: {} }), h.ctx, PLAYER_ID) },
    { name: 'flags list', permission: 'view.flags', call: (h, t) => admin.handleAdminFlags(req('/v1/admin/flags', { token: t }), h.ctx) },
    { name: 'flags put', permission: 'flags.edit', call: (h, t) => admin.handleAdminFlagsPut(req('/v1/admin/flags', { method: 'PUT', token: t, body: { flags: [{ key: 'radio', enabled: true }] } }), h.ctx) },
    { name: 'config get', permission: 'view.config', call: (h, t) => admin.handleAdminConfig(req('/v1/admin/config', { token: t }), h.ctx) },
    { name: 'config put', permission: 'config.edit', call: (h, t) => admin.handleAdminConfigPut(req('/v1/admin/config', { method: 'PUT', token: t, body: { roundLengthMinutes: 45, headStartMinutes: 3, pingIntervalMinutes: 3, zoneRadiusMetres: 500, shrinkEverySeconds: 600, zoneShrinkEnabled: true } }), h.ctx) },
    { name: 'safety get', permission: 'view.safety', call: (h, t) => admin.handleAdminSafety(req('/v1/admin/safety', { token: t }), h.ctx) },
    { name: 'safety flag create', permission: 'safety.createFlag', call: (h, t) => admin.handleAdminSafetyFlagCreate(req('/v1/admin/safety/flags', { method: 'POST', token: t, body: { kind: 'fake-gps', detail: 'teleport' } }), h.ctx) },
    { name: 'safety block create', permission: 'players.block', call: (h, t) => admin.handleAdminSafetyBlockCreate(req('/v1/admin/safety/blocks', { method: 'POST', token: t, body: { playerId: PLAYER_ID, reason: 'fake GPS' } }), h.ctx) },
    { name: 'safety block delete', permission: 'safety.unblock', call: (h, t) => admin.handleAdminSafetyBlockDelete(req(`/v1/admin/safety/blocks/${PLAYER_ID}`, { method: 'DELETE', token: t }), h.ctx, PLAYER_ID) },
    { name: 'metrics', permission: 'view.costs', call: (h, t) => admin.handleAdminMetrics(req('/v1/admin/metrics', { token: t }), h.ctx) },
    { name: 'audit', permission: 'view.audit', call: (h, t) => admin.handleAdminAudit(req('/v1/admin/audit', { token: t }), h.ctx) },
    { name: 'announcements list', permission: 'view.announcements', call: (h, t) => admin.handleAdminAnnouncements(req('/v1/admin/announcements', { token: t }), h.ctx) },
    { name: 'announcement create', permission: 'announcements.edit', call: (h, t) => admin.handleAdminAnnouncementCreate(req('/v1/admin/announcements', { method: 'POST', token: t, body: { message: 'Sweep test' } }), h.ctx) },
    { name: 'announcement update', permission: 'announcements.edit', call: (h, t) => admin.handleAdminAnnouncementUpdate(req('/v1/admin/announcements/aaaaaaaa-0000-4000-8000-000000000001', { method: 'PUT', token: t, body: { message: 'Updated' } }), h.ctx, 'aaaaaaaa-0000-4000-8000-000000000001') },
    { name: 'announcement delete', permission: 'announcements.edit', call: (h, t) => admin.handleAdminAnnouncementDelete(req('/v1/admin/announcements/aaaaaaaa-0000-4000-8000-000000000001', { method: 'DELETE', token: t }), h.ctx, 'aaaaaaaa-0000-4000-8000-000000000001') },
    { name: 'users list', permission: 'view.users', call: (h, t) => admin.handleAdminUsers(req('/v1/admin/users', { token: t }), h.ctx) },
    { name: 'user create', permission: 'users.manage', call: (h, t) => admin.handleAdminUserCreate(req('/v1/admin/users', { method: 'POST', token: t, body: { username: 'sweep-admin', role: 'admin', password: 'password-123' } }), h.ctx) },
    { name: 'user update', permission: 'users.manage', call: (h, t) => admin.handleAdminUserUpdate(req(`/v1/admin/users/${ADMIN_ID}`, { method: 'PUT', token: t, body: { role: 'staff' } }), h.ctx, ADMIN_ID) },
    { name: 'user delete', permission: 'users.manage', call: (h, t) => admin.handleAdminUserDelete(req(`/v1/admin/users/${ADMIN_ID}`, { method: 'DELETE', token: t }), h.ctx, ADMIN_ID) },
    { name: 'change password', permission: 'users.changePassword', call: (h, t) => admin.handleAdminChangePassword(req('/v1/admin/auth/change-password', { method: 'POST', token: t, body: { currentPassword: 'password-123', newPassword: 'sweep-new-password' } }), h.ctx) },
    { name: 'revoke sessions', permission: 'users.manage', call: (h, t) => admin.handleAdminRevokeSessions(req(`/v1/admin/users/${ADMIN_ID}/revoke-sessions`, { method: 'POST', token: t, body: {} }), h.ctx, ADMIN_ID) },
    { name: 'billing overview', permission: 'view.billing', call: (h, t) => admin.handleAdminBillingOverview(req('/v1/admin/billing/overview', { token: t }), h.ctx) },
    { name: 'billing transactions', permission: 'view.billing', call: (h, t) => admin.handleAdminBillingTransactions(req('/v1/admin/billing/transactions', { token: t }), h.ctx) },
    { name: 'billing plans', permission: 'view.billing', call: (h, t) => admin.handleAdminBillingPlans(req('/v1/admin/billing/plans', { token: t }), h.ctx) },
    { name: 'billing providers', permission: 'view.billing', call: (h, t) => admin.handleAdminBillingProviders(req('/v1/admin/billing/providers', { token: t }), h.ctx) },
    { name: 'billing refunds', permission: 'view.billing', call: (h, t) => admin.handleAdminBillingRefunds(req('/v1/admin/billing/refunds', { token: t }), h.ctx) },
    { name: 'billing tax', permission: 'view.billing', call: (h, t) => admin.handleAdminBillingTax(req('/v1/admin/billing/tax', { token: t }), h.ctx) },
    { name: 'users directory', permission: 'view.accounts', call: (h, t) => admin.handleAdminUsersDirectory(req('/v1/admin/users-directory', { token: t }), h.ctx) },
    { name: 'directory detail', permission: 'view.accounts', call: (h, t) => admin.handleAdminUsersDirectoryDetail(req(`/v1/admin/users-directory/${PLAYER_ID}`, { token: t }), h.ctx, PLAYER_ID) },
    { name: 'directory ban', permission: 'players.block', call: (h, t) => admin.handleAdminDirectoryBan(req(`/v1/admin/users-directory/${PLAYER_ID}/ban`, { method: 'POST', token: t, body: { reason: 'sweep' } }), h.ctx, PLAYER_ID, 'ban') },
    { name: 'directory suspend', permission: 'players.block', call: (h, t) => admin.handleAdminDirectoryBan(req(`/v1/admin/users-directory/${PLAYER_ID}/suspend`, { method: 'POST', token: t, body: { reason: 'sweep', suspendDays: 7 } }), h.ctx, PLAYER_ID, 'suspend') },
    { name: 'directory unban', permission: 'players.unblock', call: (h, t) => admin.handleAdminDirectoryBan(req(`/v1/admin/users-directory/${PLAYER_ID}/unban`, { method: 'POST', token: t, body: {} }), h.ctx, PLAYER_ID, 'unban') },
    { name: 'data requests', permission: 'view.accounts', call: (h, t) => admin.handleAdminDataRequests(req('/v1/admin/data-requests', { token: t }), h.ctx) },
    { name: 'login methods', permission: 'view.accounts', call: (h, t) => admin.handleAdminLoginMethods(req('/v1/admin/login-methods', { token: t }), h.ctx) },
  ];
  assert.equal(sweep.length, 45, 'the sweep covers every gated admin handler');
  for (const entry of sweep) {
    for (const role of ['owner', 'admin', 'staff']) {
      // A fresh harness per (case, role): mutating cases (erase,
      // kick, password change) must not poison the next role's run.
      const db = createDb();
      seedUsers(db);
      seedLiveRoom(db);
      db.announcements.push({ id: 'aaaaaaaa-0000-4000-8000-000000000001', message: 'Sweep', active: true, created_by: 'owner', created_at: NOW, updated_at: NOW });
      const h = makeHarness(db);
      globalThis.fetch = makeFetch(db);
      const userId = role === 'owner' ? OWNER_ID : role === 'admin' ? ADMIN_ID : STAFF_ID;
      const token = await sessionFor(h, userId);
      const res = await callAdmin(h, (r, c) => entry.call({ ...h, ctx: c }, token), req('/x', { token }));
      const allowed = adminCan(role, entry.permission);
      if (allowed) {
        assert.notEqual(res.status, 403, `${entry.name} must ALLOW ${role} (matrix: ${entry.permission})`);
        assert.notEqual(res.status, 401, `${entry.name} must not 401 ${role}`);
      } else {
        assert.equal(res.status, 403, `${entry.name} must DENY ${role} (matrix: ${entry.permission})`);
      }
    }
  }
});
