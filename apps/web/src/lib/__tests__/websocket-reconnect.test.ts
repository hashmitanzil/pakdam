import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PakdamSocket, fetchWsTicket, createLivePakdamSocket, getWorkerUrl,
} from '../websocket.js';
import {
  fetchLiveCatchToken, fetchLiveRoomState, startLiveMatch,
  updateLiveRoomConfig, removeLivePlayer,
  WorkerResponseError, WorkerUnreachableError,
} from '../live-room-client.js';
import type { WsLike } from '../websocket.js';

// ---------------------------------------------------------------------------
// Worker 8 — regression tests for live wiring, web client side.
//
// PakdamSocket (apps/web/src/lib/websocket.ts) is the live transport:
// the seat's STORED reconnect token is exchanged over HTTPS for a
// single-use WS ticket (fetchWsTicket / ticketProvider), the ticket
// travels ONLY in the handshake query string, `hello` carries NO
// credential, and a dropped socket reconnects as the SAME player —
// the server re-binds the seat from the fresh ticket, never from a
// display name.
//
// RUNNING: apps/web has no unit-test runner (Playwright e2e only), so
// these run under plain node --test after a tsc compile to scratch
// inside the repo (so '@pakdam/shared' resolves via the workspace
// node_modules). From pakdam-app/:
//   ./node_modules/.bin/tsc apps/web/src/lib/websocket.ts \
//     apps/web/src/lib/session-credentials.ts \
//     apps/web/src/lib/demo-store.ts apps/web/src/lib/live-client.ts \
//     apps/web/src/lib/__tests__/websocket-reconnect.test.ts \
//     apps/web/src/lib/__tests__/session-credentials.test.ts \
//     apps/web/src/lib/__tests__/live-client.test.ts \
//     --outDir .scratch-web-test --module esnext \
//     --moduleResolution bundler --target es2022 \
//     --lib es2022,dom --strict --skipLibCheck --esModuleInterop \
//     --types node --jsx react-jsx
//   # tsc emits extensionless relative imports (bundler style); node
//   # ESM needs .js — fix up the scratch output only, never source:
//   find .scratch-web-test -name '*.js' -exec sed -i \
//     -e "s|'./demo-store'|'./demo-store.js'|g" \
//     -e "s|'./session-credentials'|'./session-credentials.js'|g" \
//     -e "s|'./websocket'|'./websocket.js'|g" {} +
//   node --test .scratch-web-test/__tests__/websocket-reconnect.test.js \
//     .scratch-web-test/__tests__/session-credentials.test.js \
//     .scratch-web-test/__tests__/live-client.test.js
//   rm -rf .scratch-web-test
// Do NOT commit .scratch-web-test. (tsc is clean on this file set
// as of 2026-11-17 — the earlier websocket.ts errors are fixed:
// no duplicate type imports, no 'heartbeat' case error, no
// un-narrowed ping union. Verified: scratch tsc exit 0, zero
// errors; the tests below run from that clean compile.)
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Controllable stand-in for a WebSocket (PakdamSocket takes a factory). */
class MockSocket implements WsLike {
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  url: string;
  // No parameter property (`constructor(public url)`) — Node's
  // strip-only TS mode (how this file runs: `node --test`) cannot
  // transform one; assign explicitly instead.
  constructor(url: string) { this.url = url; }
  send(data: string): void { this.sent.push(data); }
  close(code = 1000, reason = 'client close'): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code, reason });
  }
  open(): void { this.onopen?.({}); }
  receive(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
  drop(code: number): void { this.onclose?.({ code }); }
  lastSent<T = Record<string, unknown>>(): T {
    return JSON.parse(this.sent[this.sent.length - 1]!) as T;
  }
  sentOfType(type: string): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((m) => m['type'] === type);
  }
}

interface SocketHarness {
  socket: PakdamSocket;
  sockets: MockSocket[];
  tickets: string[];
}

/** Build a socket whose ticket provider hands out fresh tickets from a
 *  list — the client-side half of "reconnect with a stored token":
 *  every (re)connect fetches a NEW single-use ticket over HTTPS with
 *  the SAME stored reconnect credential. */
function harness(tickets: string[] = ['ticket-1', 'ticket-2', 'ticket-3', 'ticket-4']): SocketHarness {
  const sockets: MockSocket[] = [];
  const used: string[] = [];
  const provider = async () => {
    const t = tickets[used.length] ?? `ticket-${used.length + 1}`;
    used.push(t);
    return t;
  };
  const socket = new PakdamSocket('https://worker.example', provider, {
    playerId: 'p1',
    clientVersion: 'pakdam-web/0.1.0-test',
    webSocketFactory: (url) => {
      const mock = new MockSocket(url);
      sockets.push(mock);
      return mock;
    },
    reconnectBaseDelayMs: 5,
    reconnectMaxDelayMs: 20,
    maxReconnectAttempts: 3,
  });
  return { socket, sockets, tickets: used };
}

async function connect(h: SocketHarness, serverSeq = 0): Promise<MockSocket> {
  await h.socket.connect('r1', { playerId: 'p1' });
  const mock = h.sockets[0]!;
  mock.open();
  // hello is sent on open; welcome moves the socket to 'connected'.
  mock.receive({ v: 1, type: 'welcome', roomId: 'r1', eventId: 'e1', serverSeq, serverTs: 1000, payload: { playerId: 'p1', serverSeq, serverTs: 1000, protocolVersion: 1 } });
  return mock;
}

test('reconnect (2d): the ticket travels ONLY in the handshake query string and hello carries NO credential', async (t) => {
  const h = harness();
  t.after(() => h.socket.close());
  const mock = await connect(h);
  assert.equal(h.socket.getState(), 'connected');
  assert.match(mock.url, /^wss:\/\/worker\.example\/v1\/rooms\/r1\/ws\?ticket=ticket-1$/);
  const hello = mock.sentOfType('hello')[0]!;
  assert.equal(hello['playerId'], 'p1');
  const payload = hello['payload'] as Record<string, unknown>;
  assert.equal(payload['protocolVersion'], 1);
  assert.equal(typeof payload['clientVersion'], 'string');
  assert.equal(typeof payload['lastServerSeq'], 'number');
  assert.ok(!('ticket' in payload) && !('token' in payload) && !('reconnectToken' in payload),
    'hello must never carry a credential (17 §3.1 rule 4)');
  assert.ok(!('ticket' in hello) && !('token' in hello));
});

test('reconnect (2e): a 4401 close fetches a FRESH ticket and reconnects once as the SAME player', async (t) => {
  const h = harness();
  t.after(() => h.socket.close());
  const first = await connect(h);
  assert.equal(h.tickets.length, 1, 'one ticket fetched for the first connect');
  first.drop(4401); // ticket invalid / reused / expired
  await sleep(30);
  assert.equal(h.sockets.length, 2, 'a fresh socket opens after 4401');
  assert.equal(h.tickets.length, 2, 'the reconnect fetched a fresh ticket first');
  assert.match(h.sockets[1]!.url, /ticket=ticket-2$/);
  h.sockets[1]!.open();
  const hello = h.sockets[1]!.sentOfType('hello')[0]!;
  assert.equal(hello['playerId'], 'p1', 'the reconnect is the same player, not a new seat');
  assert.equal(h.socket.getState(), 'reconnecting');
  h.sockets[1]!.receive({ v: 1, type: 'welcome', roomId: 'r1', eventId: 'e2', serverSeq: 0, serverTs: 1000, payload: { playerId: 'p1', serverSeq: 0, serverTs: 1000, protocolVersion: 1 } });
  assert.equal(h.socket.getState(), 'connected');
});

test('reconnect (2f): a second 4401 does NOT loop forever — the socket closes instead of retrying', async (t) => {
  const h = harness();
  t.after(() => h.socket.close());
  await connect(h);
  h.sockets[0]!.drop(4401);
  await sleep(30);
  assert.equal(h.sockets.length, 2);
  h.sockets[1]!.open();
  h.sockets[1]!.drop(4401);
  await sleep(30);
  assert.equal(h.sockets.length, 2, 'no third socket: one fresh-ticket retry only');
  assert.equal(h.socket.getState(), 'closed');
});

test('reconnect (2g): a dropped socket (1006) reconnects with backoff, re-uses the same player, and re-syncs from lastServerSeq', async (t) => {
  const h = harness();
  t.after(() => h.socket.close());
  const first = await connect(h, 7);
  // A server event advances lastServerSeq to 7 (welcome carried it).
  assert.equal(h.socket.getLastServerSeq(), 7);
  first.drop(1006);
  assert.equal(h.socket.getState(), 'reconnecting');
  await sleep(60);
  assert.equal(h.sockets.length, 2, 'backoff reconnect opened a new socket');
  assert.equal(h.tickets.length, 2, 'the reconnect fetched a fresh ticket');
  const second = h.sockets[1]!;
  second.open();
  // hello replays lastServerSeq so the server knows where we left off.
  const hello = second.sentOfType('hello')[0]!;
  assert.equal((hello['payload'] as Record<string, unknown>)['lastServerSeq'], 7);
  // Welcome triggers snapshot.request with the same lastServerSeq —
  // the snapshot is the whole truth; stale commands are never replayed.
  second.receive({ v: 1, type: 'welcome', roomId: 'r1', eventId: 'e3', serverSeq: 7, serverTs: 1000, payload: { playerId: 'p1', serverSeq: 7, serverTs: 1000, protocolVersion: 1 } });
  const snapReq = second.sentOfType('snapshot.request');
  assert.equal(snapReq.length, 1);
  assert.equal((snapReq[0]!['payload'] as Record<string, unknown>)['lastServerSeq'], 7);
  assert.equal(h.socket.getState(), 'connected');
});

test('reconnect (2h): 1000 / 4403 / 4409 never auto-reconnect', async (_t) => {
  for (const code of [1000, 4403, 4409]) {
    const h = harness();
    await connect(h);
    h.sockets[0]!.drop(code);
    await sleep(40);
    assert.equal(h.sockets.length, 1, `code ${code} must not open a new socket`);
    assert.equal(h.tickets.length, 1, `code ${code} must not fetch another ticket`);
    assert.equal(h.socket.getState(), 'closed');
    h.socket.close();
  }
});

test('reconnect (2i): commands sent while disconnected are discarded, never queued', async (t) => {
  const h = harness();
  t.after(() => h.socket.close());
  // Not connected yet: send fails.
  assert.equal(h.socket.sendCommand('ready.set', { isReady: true }), false);
  const mock = await connect(h);
  assert.equal(h.socket.sendCommand('ready.set', { isReady: true }), true);
  const sent = mock.sentOfType('ready.set')[0]!;
  assert.equal(typeof sent['commandId'], 'string', 'every outbound command carries a commandId (§3.6)');
  assert.equal(typeof sent['idempotencyKey'], 'string');
  // Drop the socket: further sends fail instead of queueing.
  mock.drop(1006);
  assert.equal(h.socket.sendCommand('ready.set', { isReady: true }), false, 'no offline backfill — disconnected commands are discarded');
  assert.equal(h.socket.sendLocationUpdate({ playerId: 'p1', roomId: 'r1', lat: 23.35, lng: 85.32, accuracyMeters: 8, capturedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), quality: 'good' }), false);
});

test('reconnect (2j): ticket.renewal-required fetches a fresh ticket and sends it ONLY via auth.refresh', async (t) => {
  const h = harness();
  t.after(() => h.socket.close());
  const mock = await connect(h);
  mock.receive({ v: 1, type: 'ticket.renewal-required', roomId: 'r1', eventId: 'e4', serverSeq: 0, serverTs: 1000, payload: { expiresAt: new Date().toISOString() } });
  await sleep(20);
  assert.equal(h.tickets.length, 2, 'renewal fetched a fresh ticket over HTTPS');
  const refresh = mock.sentOfType('auth.refresh');
  assert.equal(refresh.length, 1, 'exactly one auth.refresh carries the new ticket');
  assert.equal((refresh[0]!['payload'] as Record<string, unknown>)['ticket'], 'ticket-2');
  // No other sent message carries a ticket.
  for (const m of mock.sent) {
    const parsed = JSON.parse(m) as Record<string, unknown>;
    if (parsed['type'] !== 'auth.refresh') {
      assert.ok(!JSON.stringify(parsed['payload'] ?? {}).includes('ticket-2'), `${String(parsed['type'])} must not carry a ticket`);
    }
  }
});

test('create/join (5b): fetchWsTicket posts the stored reconnect credential over HTTPS and returns the ticket', async (t) => {
  const calls: { url: string; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return { ok: true, json: async () => ({ ticket: 'fresh-ticket-abc' }) } as Response;
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const ticket = await fetchWsTicket('https://worker.example', 'r1', 'p1', 'stored-reconnect-token');
  assert.equal(ticket, 'fresh-ticket-abc');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://worker.example/v1/rooms/r1/ws-ticket');
  assert.deepEqual(calls[0]!.body, { playerId: 'p1', reconnectToken: 'stored-reconnect-token', purpose: 'connect' },
    'the ticket request proves the seat with the stored reconnect token — no Authorization header, no token in a URL; purpose connect opens a socket (SEC-11: a renew ticket never may)');

  // A non-OK response (e.g. 403 wrong token) throws — the caller must not proceed without a ticket.
  globalThis.fetch = (async () => ({ ok: false, json: async () => ({ error: 'reconnect token does not match this seat' }) }) as Response) as typeof fetch;
  await assert.rejects(fetchWsTicket('https://worker.example', 'r1', 'p1', 'wrong-token'), /Could not get a connection ticket/);
});

test('create/join (5c): createLivePakdamSocket is null without a Worker URL and live only with one', async (t) => {
  const prev = process.env['NEXT_PUBLIC_WORKER_URL'];
  delete process.env['NEXT_PUBLIC_WORKER_URL'];
  t.after(() => {
    if (prev === undefined) delete process.env['NEXT_PUBLIC_WORKER_URL'];
    else process.env['NEXT_PUBLIC_WORKER_URL'] = prev;
  });
  assert.equal(getWorkerUrl(), null);
  assert.equal(createLivePakdamSocket({ roomId: 'r1', playerId: 'p1', reconnectToken: 'tok' }), null,
    'without a Worker URL the app stays on the local demo loop — never a guessed URL');
  process.env['NEXT_PUBLIC_WORKER_URL'] = 'https://pakdam.example.workers.dev/';
  assert.equal(getWorkerUrl(), 'https://pakdam.example.workers.dev', 'trailing slashes are stripped');
  const live = createLivePakdamSocket({ roomId: 'r1', playerId: 'p1', reconnectToken: 'tok' });
  assert.ok(live instanceof PakdamSocket);
  live.close();
});

test('catch-token (3e): fetchLiveCatchToken posts the seat credential + catchId and returns the one-time token', async (t) => {
  const calls: { url: string; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return { ok: true, status: 200, json: async () => ({ ok: true, token: 'QR-TOKEN-123', catchId: 'c1' }) } as Response;
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const token = await fetchLiveCatchToken('https://worker.example', 'r1', 'r1', 'seat-token-r1', 'c1');
  assert.equal(token, 'QR-TOKEN-123');
  assert.equal(calls[0]!.url, 'https://worker.example/v1/rooms/r1/catch-token');
  assert.deepEqual(calls[0]!.body, { playerId: 'r1', reconnectToken: 'seat-token-r1', catchId: 'c1' },
    'the seat is proven with its reconnect token; the token is fetched over HTTPS, never from a snapshot');
});

test('catch-token (3f): fetchLiveCatchToken distinguishes "server said no" (404) from "server unreachable"', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async () => ({
    ok: false, status: 404, json: async () => ({ error: 'no token for this catch and seat' }),
  }) as Response) as typeof fetch;
  await assert.rejects(
    fetchLiveCatchToken('https://worker.example', 'r1', 'h1', 'seat-token-h1', 'c1'),
    (e: unknown) => e instanceof WorkerResponseError && (e as WorkerResponseError).status === 404,
  );
  globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  await assert.rejects(
    fetchLiveCatchToken('https://worker.example', 'r1', 'r1', 'seat-token-r1', 'c1'),
    (e: unknown) => e instanceof WorkerUnreachableError,
  );
});

test('get-state (3g): fetchLiveRoomState returns the recipient-filtered state, and null for a non-seat (404)', async (t) => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ room: { roomId: 'r1' }, players: [], version: 3 }) } as Response;
  }) as typeof fetch;
  const state = await fetchLiveRoomState('https://worker.example', 'r1', 'p1');
  assert.equal(state?.version, 3);
  assert.equal(calls[0], 'https://worker.example/v1/rooms/r1?playerId=p1');

  globalThis.fetch = (async () => ({
    ok: false, status: 404, json: async () => ({ error: 'not a player in this room' }),
  }) as Response) as typeof fetch;
  assert.equal(await fetchLiveRoomState('https://worker.example', 'r1', 'not-a-seat'), null);
});

// CONTRACT-ONLY — host actions over HTTPS must prove host with the HOST token.
// Contract, quoted from workers/src/http.ts (Worker 5, SEC-06):
//   hostTokenBody: "Host-only actions (Worker 5, SEC-06) prove host
//   authority with the host token: `{ playerId, hostToken }`. ...
//   A missing field is 400 (strict schema); a wrong token, or a
//   non-host seat, is 403."
//   updateConfigBody / removePlayerBody: "Auth is the HOST token
//   (Worker 5, SEC-06), same as config/start."
// The client now (live-room-client.ts) sends `{ playerId, hostToken }`
// to /start, /config and /remove-player — the host token, not the
// reconnect token. This test pins the server contract; un-skipped
// 2026-11-17 (Worker H) once the client passed the stored host token.
test('SEC-06 CONTRACT-ONLY: startLiveMatch / updateLiveRoomConfig / removeLivePlayer prove host with hostToken, not the reconnect token', async (t) => {
  const calls: { url: string; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    return { ok: true, status: 200, json: async () => ({ phase: 'HEAD_START', startedAt: '', endsAt: '' }) } as Response;
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  await startLiveMatch('https://worker.example', 'r1', 'h1', 'host-token-h1');
  assert.deepEqual(calls[0]!.body, { playerId: 'h1', hostToken: 'host-token-h1' },
    'start proves host with the host token — a reconnect token here 400s');
  await updateLiveRoomConfig('https://worker.example', 'r1', 'h1', 'host-token-h1', {} as never);
  assert.deepEqual(
    (calls[1]!.body as Record<string, unknown>)['hostToken'], 'host-token-h1',
    'config change proves host with the host token',
  );
  assert.ok(!('reconnectToken' in (calls[1]!.body as Record<string, unknown>)));
  await removeLivePlayer('https://worker.example', 'r1', 'h1', 'host-token-h1', 'r2');
  assert.deepEqual(calls[2]!.body, { playerId: 'h1', hostToken: 'host-token-h1', targetPlayerId: 'r2' });
});

// CONTRACT-ONLY — GET /v1/rooms/:id proves the seat with the reconnect token.
// Contract, quoted from workers/src/index.ts (handleGetState, Worker 5):
//   "a playerId alone no longer opens the room. The caller proves
//    the seat with the raw reconnect token — via `Authorization:
//    Bearer <token>` (preferred ...) or `?reconnectToken=` as a
//    fallback."
// The client now (live-room-client.ts `fetchLiveRoomState`) takes the
// reconnect token as its 4th argument and sends it as
// `Authorization: Bearer <token>`. Un-skipped 2026-11-17 (Worker H).
test('get-state CONTRACT-ONLY: fetchLiveRoomState sends the seat reconnect token as Authorization Bearer', async (t) => {
  const calls: { url: string; headers: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { headers?: unknown }) => {
    calls.push({ url, headers: init?.headers });
    return { ok: true, status: 200, json: async () => ({ room: { roomId: 'r1' }, players: [], version: 3 }) } as Response;
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  // The token is the function's 4th argument (the cast below is kept
  // from the skipped version); require the Bearer header.
  const fetchWithToken = fetchLiveRoomState as unknown as (
    apiUrl: string, roomId: string, playerId: string, reconnectToken: string,
  ) => Promise<unknown>;
  await fetchWithToken('https://worker.example', 'r1', 'p1', 'seat-token-p1');
  assert.equal(calls.length, 1);
  const headers = calls[0]!.headers as Record<string, string> | undefined;
  assert.equal(headers?.['Authorization'], 'Bearer seat-token-p1',
    'the seat is proven with the reconnect token, never with playerId alone');
});

// --- Team Radio TEXT (D-M7) — client send side ---
//
// sendRadioMessage is a thin sendCommand wrapper: the DO does the
// relay (team-only), the validation (1–140 chars) and the sender-name
// stamping. These tests pin the wire shape only — the server half is
// covered by workers/test/radio.test.ts.

test('radio (D-M7): sendRadioMessage sends radio.send with text + kind, commandId and idempotencyKey', async (t) => {
  const h = harness();
  t.after(() => h.socket.close());
  const mock = await connect(h);
  assert.equal(h.socket.sendRadioMessage('Moving to a new spot', 'text'), true);
  const sent = mock.sentOfType('radio.send');
  assert.equal(sent.length, 1);
  const msg = sent[0]!;
  assert.equal((msg['payload'] as Record<string, unknown>)['text'], 'Moving to a new spot');
  assert.equal((msg['payload'] as Record<string, unknown>)['kind'], 'text');
  assert.equal(msg['playerId'], 'p1');
  assert.equal(msg['roomId'], 'r1');
  assert.match(String(msg['commandId']), /^[0-9a-f-]{36}$/);
  assert.equal(msg['commandId'], msg['idempotencyKey']);
});

test('radio (D-M7): quick messages carry kind quick; kind defaults to text', async (t) => {
  const h = harness();
  t.after(() => h.socket.close());
  const mock = await connect(h);
  assert.equal(h.socket.sendRadioMessage('Stay spread out', 'quick'), true);
  assert.equal((mock.sentOfType('radio.send')[0]!['payload'] as Record<string, unknown>)['kind'], 'quick');
  assert.equal(h.socket.sendRadioMessage('hello'), true);
  assert.equal((mock.sentOfType('radio.send')[1]!['payload'] as Record<string, unknown>)['kind'], 'text');
});

test('radio (D-M7): sendRadioMessage while disconnected returns false and sends nothing', async (t) => {
  const h = harness();
  t.after(() => h.socket.close());
  const mock = h.sockets[0]! ?? null;
  // Never connected: no socket exists yet, nothing can be sent.
  assert.equal(h.socket.sendRadioMessage('hello'), false);
  assert.equal(mock, null);
  await connect(h);
  h.socket.close();
  assert.equal(h.socket.getState(), 'closed');
  const sentBefore = h.sockets[0]!.sent.length;
  assert.equal(h.socket.sendRadioMessage('hello'), false, 'a closed socket discards the message, never queues it');
  assert.equal(h.sockets[0]!.sent.length, sentBefore);
});
