import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * WS-protocol test for the web client (apps/web/src/lib/websocket.ts).
 * The client source is transpiled at test time with the workspace
 * TypeScript compiler (type-only import of @pakdam/shared, so the output
 * has no runtime imports) and loaded IN MEMORY from a `data:` URL —
 * no temp file is written at load (D-M13, 2026-11-17: the old
 * mkdtempSync + writeFileSync made the whole engine suite un-runnable
 * in write-blocked environments). The socket itself is a mock
 * WebSocket injected via the client's webSocketFactory option —
 * no network, no server.
 */
const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof import('typescript');
const clientSrcPath = fileURLToPath(
  // Dist run: tests run from dist/test/ (compiled), one level deeper
  // than src/test/. Source run (write-blocked VM, no dist): from
  // src/test/ directly. Try the dist-relative path first so compiled
  // runs are unchanged, then the source-relative one.
  [
    new URL('../../../../apps/web/src/lib/websocket.ts', import.meta.url),
    new URL('../../../apps/web/src/lib/websocket.ts', import.meta.url),
  ].find((u) => existsSync(fileURLToPath(u))) ??
    new URL('../../../../apps/web/src/lib/websocket.ts', import.meta.url),
);
const transpiled = ts.transpileModule(readFileSync(clientSrcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const clientMod = (await import(
  `data:text/javascript;base64,${Buffer.from(transpiled, 'utf8').toString('base64')}`
)) as unknown as {
  PakdamSocket: new (
    apiUrl: string,
    ticketProvider: () => Promise<string>,
    options?: Record<string, unknown>,
  ) => PakdamSocketLike;
};

interface PakdamSocketLike {
  connect(roomId: string, callbacks: Record<string, unknown>): Promise<void>;
  retry(): Promise<void>;
  close(code?: number, reason?: string): void;
  getState(): string;
  getLastServerSeq(): number;
  getMissedHeartbeats(): number;
  sendCommand(type: string, payload: Record<string, unknown>): boolean;
  handleVisibilityHidden(): void;
  handleVisibilityVisible(): void;
}
const { PakdamSocket } = clientMod;

type Handler = ((ev: unknown) => void) | null;
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static reset(): void { MockWebSocket.instances = []; }
  sent: string[] = [];
  onopen: Handler = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: Handler = null;
  url: string;
  // No parameter property (`constructor(public url)`) — Node's
  // strip-only mode cannot parse it, so the field is declared above.
  constructor(url: string) { this.url = url; MockWebSocket.instances.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(code = 1000, reason = ''): void { this.onclose?.({ code, reason }); }
  simulateOpen(): void { this.onopen?.({}); }
  simulateMessage(obj: unknown): void { this.onmessage?.({ data: JSON.stringify(obj) }); }
  simulateClose(code: number): void { this.onclose?.({ code }); }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const welcome = (serverSeq: number) => ({
  v: 1, type: 'welcome', roomId: 'r1', eventId: 'e-welcome', serverSeq, serverTs: 1000,
  payload: { playerId: 'p1', serverSeq, serverTs: 1000, protocolVersion: 1 },
});
const snapshot = (serverSeq: number) => ({
  v: 1, type: 'snapshot', roomId: 'r1', eventId: 'e-snap', serverSeq, serverTs: 1000,
  payload: {
    room: { roomId: 'r1' }, players: [], phase: 'LOBBY', version: 1, serverSeq,
    locationStatus: {}, activeCatches: [],
    safetyState: { paused: false, pausedBy: null, pausedAt: null, sosActive: false },
    missedAnnouncements: [],
  },
});

test('WS client: ticket travels in the query string only — hello carries no credential', async () => {
  MockWebSocket.reset();
  const received: unknown[] = [];
  const socket = new PakdamSocket('https://api.example.test', async () => 'TICKET-1', {
    playerId: 'p1',
    webSocketFactory: (url: string) => new MockWebSocket(url),
  });
  try {
    await socket.connect('r1', { onMessage: (m: unknown) => { received.push(m); } });
    const ws = MockWebSocket.instances[0]!;
    assert.ok(ws.url.includes('/v1/rooms/r1/ws?ticket=TICKET-1'), ws.url);
    assert.ok(!ws.url.includes('TICKET-1&') && ws.url.endsWith('TICKET-1'));
    ws.simulateOpen();
    assert.equal(ws.sent.length, 1);
    const hello = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    assert.equal(hello['type'], 'hello');
    assert.equal(hello['v'], 1);
    for (const field of ['ticket', 'token', 'password', 'authToken', 'reconnectToken']) {
      assert.ok(!(field in hello), `hello must not carry ${field}`);
      assert.ok(!(field in (hello['payload'] as Record<string, unknown>)), `hello payload must not carry ${field}`);
    }
    assert.equal((hello['payload'] as Record<string, unknown>)['protocolVersion'], 1);
    assert.equal((hello['payload'] as Record<string, unknown>)['lastServerSeq'], 0);
    assert.ok(typeof hello['commandId'] === 'string' && (hello['commandId'] as string).length > 0);
    // Every command carries an idempotencyKey (crypto.randomUUID).
    const ok = socket.sendCommand('ready.set', { isReady: true });
    assert.equal(ok, false); // not connected yet — discarded, never queued
    ws.simulateMessage(welcome(1));
    assert.equal(socket.getState(), 'connected');
    assert.equal(socket.sendCommand('ready.set', { isReady: true }), true);
    const cmd = JSON.parse(ws.sent[ws.sent.length - 1]!) as Record<string, unknown>;
    assert.equal(cmd['type'], 'ready.set');
    assert.equal(cmd['commandId'], cmd['idempotencyKey']);
    assert.match(String(cmd['commandId']), /^[0-9a-f-]{36}$/);
  } finally {
    socket.close();
  }
});

test('WS client: ticket.renewal-required fetches a fresh ticket and sends auth.refresh (the only ticket-bearing message)', async () => {
  MockWebSocket.reset();
  const tickets = ['TICKET-1', 'TICKET-2'];
  let calls = 0;
  const socket = new PakdamSocket('https://api.example.test', async () => tickets[calls++]!, {
    playerId: 'p1',
    webSocketFactory: (url: string) => new MockWebSocket(url),
  });
  try {
    await socket.connect('r1', {});
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage(welcome(1));
    ws.simulateMessage(snapshot(2));
    ws.simulateMessage({
      v: 1, type: 'ticket.renewal-required', roomId: 'r1', eventId: 'e-rr',
      serverSeq: 3, serverTs: 1000, payload: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    await sleep(20);
    const refreshes = ws.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((m) => m['type'] === 'auth.refresh');
    assert.equal(refreshes.length, 1);
    assert.equal((refreshes[0]!['payload'] as Record<string, unknown>)['ticket'], 'TICKET-2');
    // No other sent message carries a ticket value.
    for (const s of ws.sent) {
      const m = JSON.parse(s) as Record<string, unknown>;
      if (m['type'] !== 'auth.refresh') {
        assert.ok(!JSON.stringify(m).includes('TICKET-'), `message ${String(m['type'])} must not carry a ticket`);
      }
    }
    assert.equal(calls, 2); // initial ticket + renewal ticket
  } finally {
    socket.close();
  }
});

test('WS client: backoff on 1006, snapshot.request on reconnect, then reconnect-failed with Retry', async () => {
  MockWebSocket.reset();
  const states: string[] = [];
  const snapshots: unknown[] = [];
  const received: unknown[] = [];
  const socket = new PakdamSocket('https://api.example.test', async () => 'TICKET-1', {
    playerId: 'p1',
    maxReconnectAttempts: 2, reconnectBaseDelayMs: 1, reconnectMaxDelayMs: 5,
    webSocketFactory: (url: string) => new MockWebSocket(url),
  });
  try {
    await socket.connect('r1', {
      onMessage: (m: unknown) => { received.push(m); },
      onSnapshot: (s: unknown) => { snapshots.push(s); },
      onStateChange: (s: string) => { states.push(s); },
    });
    const ws1 = MockWebSocket.instances[0]!;
    ws1.simulateOpen();
    ws1.simulateMessage(welcome(5));
    assert.equal(socket.getState(), 'connected');
    ws1.simulateClose(1006);
    assert.equal(socket.getState(), 'reconnecting');
    await sleep(50);
    assert.equal(MockWebSocket.instances.length, 2, 'one reconnect attempt opens a second socket');
    const ws2 = MockWebSocket.instances[1]!;
    ws2.simulateOpen();
    ws2.simulateMessage(welcome(7));
    assert.equal(socket.getState(), 'connected');
    // Reconnect asks for a fresh snapshot with lastServerSeq.
    const resync = ws2.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
      .find((m) => m['type'] === 'snapshot.request');
    assert.ok(resync, 'snapshot.request sent after reconnect');
    assert.equal((resync!['payload'] as Record<string, unknown>)['lastServerSeq'], 7);
    ws2.simulateMessage(snapshot(9));
    assert.equal(snapshots.length, 1);
    assert.equal(socket.getLastServerSeq(), 9);
    // Stale events (serverSeq <= last applied) are dropped: onMessage count
    // must not grow (it already holds welcome/snapshot messages from before).
    const receivedBeforeStale = received.length;
    ws2.simulateMessage({
      v: 1, type: 'room.state', roomId: 'r1', eventId: 'e-stale', serverSeq: 9,
      serverTs: 1000, payload: { phase: 'ACTIVE', version: 1, serverSeq: 9, reason: null },
    });
    assert.equal(received.length, receivedBeforeStale);
    ws2.simulateClose(1006);
    await sleep(50);
    assert.equal(MockWebSocket.instances.length, 3, 'second reconnect attempt opens a third socket');
    MockWebSocket.instances[2]!.simulateClose(1006);
    await sleep(50);
    assert.equal(socket.getState(), 'reconnect-failed');
    assert.ok(states.includes('reconnect-failed'));
    assert.equal(MockWebSocket.instances.length, 3, 'no further attempts after max');
  } finally {
    socket.close();
  }
});

test('WS client: no reconnect on 1000; 4401 fetches a fresh ticket and reconnects once, then stops', async () => {
  MockWebSocket.reset();
  const socket = new PakdamSocket('https://api.example.test', async () => 'TICKET-1', {
    playerId: 'p1',
    maxReconnectAttempts: 5, reconnectBaseDelayMs: 1, reconnectMaxDelayMs: 5,
    webSocketFactory: (url: string) => new MockWebSocket(url),
  });
  try {
    await socket.connect('r1', {});
    const ws1 = MockWebSocket.instances[0]!;
    ws1.simulateOpen();
    ws1.simulateMessage(welcome(1));
    ws1.simulateClose(1000);
    assert.equal(socket.getState(), 'closed');
    assert.equal(MockWebSocket.instances.length, 1, '1000 never reconnects');
  } finally {
    socket.close();
  }

  MockWebSocket.reset();
  let ticketCalls = 0;
  const socket2 = new PakdamSocket('https://api.example.test', async () => `TICKET-${++ticketCalls}`, {
    playerId: 'p1',
    maxReconnectAttempts: 5, reconnectBaseDelayMs: 1, reconnectMaxDelayMs: 5,
    webSocketFactory: (url: string) => new MockWebSocket(url),
  });
  try {
    await socket2.connect('r1', {});
    const a = MockWebSocket.instances[0]!;
    a.simulateOpen();
    a.simulateMessage(welcome(1));
    a.simulateClose(4401);
    await sleep(50);
    assert.equal(MockWebSocket.instances.length, 2, '4401 reconnects once with a fresh ticket');
    assert.ok(MockWebSocket.instances[1]!.url.includes('TICKET-2'));
    MockWebSocket.instances[1]!.simulateClose(4401);
    await sleep(50);
    assert.equal(socket2.getState(), 'closed');
    assert.equal(MockWebSocket.instances.length, 2, 'second 4401 does not reconnect again');
  } finally {
    socket2.close();
  }
});

test('WS client: visibility hidden sends a suspension notice; visible requests a fresh snapshot', async () => {
  MockWebSocket.reset();
  const socket = new PakdamSocket('https://api.example.test', async () => 'TICKET-1', {
    playerId: 'p1',
    webSocketFactory: (url: string) => new MockWebSocket(url),
  });
  try {
    await socket.connect('r1', {});
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();
    ws.simulateMessage(welcome(1));
    socket.handleVisibilityHidden();
    assert.equal(socket.getState(), 'suspended');
    const notice = ws.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
      .find((m) => m['type'] === 'player.suspended');
    assert.ok(notice, 'suspension notice sent on hidden');
    assert.equal((notice!['payload'] as Record<string, unknown>)['reason'], 'tab-hidden');
    socket.handleVisibilityVisible();
    assert.equal(socket.getState(), 'connected');
    const resync = ws.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
      .find((m) => m['type'] === 'snapshot.request');
    assert.ok(resync, 'fresh snapshot requested on visible');
  } finally {
    socket.close();
  }
});
