/**
 * @pakdam/workers — Durable Object classes.
 *
 * `RoomDO` — one per room. Owns the socket, the ticket registry, the alarm
 * tick, and all game authority (via `RoomStore` in room-do.ts). The Worker
 * is a thin front door: it validates HTTP bodies and forwards.
 *
 * `CodeRegistryDO` — a single registry DO that owns invite-code -> roomId
 * mappings. A code lookup must work from ANY isolate, so the mapping cannot
 * live in Worker memory or inside one room's DO; it lives here, single-owner.
 *
 * HIBERNATION: sockets use the hibernation API (`acceptWebSocket` with a
 * playerId tag). Per-socket session records (ticket binding, heartbeat
 * bookkeeping, hello state) are keyed by PLAYER + TAB (`session:<playerId>:<sessionId>`,
 * P1-4) in durable storage with a memory cache — two tabs are two
 * independent sessions: closing one tab suspends nothing while the other
 * tab's socket is alive, and deleting one tab's session never breaks the
 * other. Durable game state is persisted after every mutation
 * (`room-state-v1`); the ticket registry, idempotency records + replies,
 * pending pings and the pending shrink preview persist with it (P1-5),
 * while memory-only state (fixes, rate windows, raw catch tokens) is
 * rebuilt empty after a wake, per the spec split.
 *
 * SOCKET IDENTITY (P0-3): the socket's real identity is the tag set at
 * upgrade from the redeemed ticket. Every envelope's `playerId` is
 * compared against that tag BEFORE any session lookup — a client that
 * claims another seat's id gets an error + close (4403).
 *
 * CLOSE CONTRACT (the client follows `WS_CLOSE_CODE_ACTION`):
 * - 4400 bad request — fresh ticket, reconnect once; surface the failure.
 * - 4401 ticket invalid/reused/expired — fresh ticket, reconnect once.
 * - 4403 forbidden (seat removed/revoked/left) — do not reconnect.
 * - 4409 protocol unsupported — do not reconnect, upgrade the client.
 * - 4413 rate-limited — back off, never before retryAfterSeconds.
 * - 1000 normal closure — do not reconnect.
 * Socket close marks the seat SUSPENDED, never removed (P0-1: resume on hello).
 */
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISSED_LIMIT,
  RENEWAL_WARNING_MS,
  hashWsTicket,
  newId,
  type WsServerMessageType,
} from '@pakdam/shared';
import {
  RoomStore,
  STATE_KEY,
  durableSnapshot,
  emptyMemory,
  restoreState,
  type OutboundEvent,
  type RoomDoState,
} from './room-do.js';
import {
  executePersistIntents,
  type PersistIntent,
  type SupabaseEnv,
} from './supabase.js';
import type { Env } from './index.js';

interface SessionRecord {
  /** Per-tab session id (one per socket; two tabs = two records, P1-4). */
  sessionId: string;
  playerId: string;
  ticketId: string;
  ticketExpiresAtMs: number;
  renewalWarned: boolean;
  lastHeartbeatAtMs: number;
  missedHeartbeats: number;
  helloDone: boolean;
}

/** Max DO /op body: 1 MB (P1-16). Larger bodies are rejected with 413. */
const MAX_OP_BODY_BYTES = 1_048_576;

/** Read a request body as text with a 1 MB cap (P1-16). */
async function readCappedBody(
  req: Request,
): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, response: json({ ok: false, error: 'Unreadable body.', code: 'VALIDATION_FAILED', status: 400 }, 400) };
  }
  if (new TextEncoder().encode(text).length > MAX_OP_BODY_BYTES) {
    return {
      ok: false,
      response: json({ ok: false, error: 'Body too large (max 1 MB).', code: 'PAYLOAD_TOO_LARGE', status: 413 }, 413),
    };
  }
  return { ok: true, text };
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function serverEnvelope(
  roomId: string,
  event: OutboundEvent,
): Record<string, unknown> {
  return {
    v: 1,
    type: event.type,
    roomId,
    eventId: event.eventId,
    serverSeq: event.serverSeq,
    serverTs: event.serverTs,
    payload: event.payload,
  };
}

// ---------------------------------------------------------------------------
// RoomDO
// ---------------------------------------------------------------------------

export class RoomDO implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private store: RoomStore | null = null;
  private loaded = false;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  // -- state ---------------------------------------------------------------

  private async load(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.loaded) return;
      const raw = await this.ctx.storage.get<RoomDoState>(STATE_KEY);
      const restored = raw === undefined ? null : restoreState(raw);
      if (restored) {
        this.store = new RoomStore(restored, emptyMemory());
        // P1-5: tickets, idempotency + replies, pending pings and the
        // pending shrink preview survive the wake with the game state.
        this.store.restoreDurableMemory();
      }
      this.loaded = true;
    });
  }

  private async save(): Promise<void> {
    if (!this.store) return;
    // P1-5: sync the durable-backed memory maps into the state first,
    // so the ticket registry / idempotency / pending pings persist.
    this.store.syncDurableMemory();
    await this.ctx.storage.put(STATE_KEY, durableSnapshot(this.store.state));
  }

  private alarmDelayMs(): number | null {
    if (!this.store) return null;
    const phase = this.store.room.phase;
    if (
      phase === 'COMPLETED' ||
      phase === 'CANCELLED' ||
      phase === 'ABANDONED' ||
      phase === 'EXPIRED'
    ) {
      return null;
    }
    if (
      phase === 'HEAD_START' ||
      phase === 'ACTIVE' ||
      phase === 'SAFETY_PAUSED'
    ) {
      return 1000;
    }
    // RESOLVING ticks at 30 s, not 1 s: the match clock has stopped and
    // nothing is live — "1 s while live" does not cover resolving.
    return 30_000;
  }

  private async armAlarm(): Promise<void> {
    const delay = this.alarmDelayMs();
    if (delay === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  private async afterMutation(
    events: OutboundEvent[],
    persist: PersistIntent[],
  ): Promise<void> {
    const nowMs = Date.now();
    await this.deliver(events, nowMs);
    if (persist.length > 0) {
      this.ctx.waitUntil(executePersistIntents(this.env as SupabaseEnv, persist));
    }
    await this.save();
    await this.armAlarm();
    await this.maybeUnregisterCode();
  }

  // -- sessions (durable storage, keyed by player + tab) --------------------

  /** Storage key for one tab's session. Legacy records (pre-P1-4) have no
   * tab suffix and live under `session:<playerId>`. */
  private sessionKey(playerId: string, sessionId: string): string {
    return sessionId === 'legacy'
      ? `session:${playerId}`
      : `session:${playerId}:${sessionId}`;
  }

  private sessionCacheKey(playerId: string, sessionId: string): string {
    return `${playerId}:${sessionId}`;
  }

  private async getSession(
    playerId: string,
    sessionId?: string,
  ): Promise<SessionRecord | null> {
    if (sessionId !== undefined) {
      const key = this.sessionCacheKey(playerId, sessionId);
      const cached = this.sessions.get(key);
      if (cached) return cached;
      const rec = await this.ctx.storage.get<SessionRecord>(
        this.sessionKey(playerId, sessionId),
      );
      if (rec === undefined) return null;
      if (!rec.sessionId) rec.sessionId = sessionId;
      this.sessions.set(key, rec);
      return rec;
    }
    // No tab given (legacy path): any cached record for the seat, else the
    // legacy key. New sockets always carry a tab tag, so this is a fallback.
    for (const rec of this.sessions.values()) {
      if (rec.playerId === playerId) return rec;
    }
    const rec = await this.ctx.storage.get<SessionRecord>(`session:${playerId}`);
    if (rec === undefined) return null;
    if (!rec.sessionId) rec.sessionId = 'legacy';
    this.sessions.set(this.sessionCacheKey(playerId, rec.sessionId), rec);
    return rec;
  }

  private async putSession(rec: SessionRecord): Promise<void> {
    this.sessions.set(this.sessionCacheKey(rec.playerId, rec.sessionId), rec);
    await this.ctx.storage.put(this.sessionKey(rec.playerId, rec.sessionId), rec);
  }

  /** Delete ONE tab's session record (P1-4) — never the seat's others. */
  private async deleteSession(playerId: string, sessionId?: string): Promise<void> {
    if (sessionId === undefined) {
      await this.deleteSessionsForPlayer(playerId);
      return;
    }
    this.sessions.delete(this.sessionCacheKey(playerId, sessionId));
    await this.ctx.storage.delete(this.sessionKey(playerId, sessionId));
  }

  /** Delete EVERY session record for a seat (seat removed / left for good). */
  private async deleteSessionsForPlayer(playerId: string): Promise<void> {
    for (const key of [...this.sessions.keys()]) {
      if (key.startsWith(`${playerId}:`)) this.sessions.delete(key);
    }
    const map = await this.ctx.storage.list<SessionRecord>({
      prefix: `session:${playerId}`,
    });
    for (const key of map.keys()) {
      await this.ctx.storage.delete(key);
    }
  }

  private async listSessions(): Promise<SessionRecord[]> {
    const map = await this.ctx.storage.list<SessionRecord>({ prefix: 'session:' });
    const out: SessionRecord[] = [];
    for (const rec of map.values()) {
      if (!rec.sessionId) rec.sessionId = 'legacy';
      this.sessions.set(this.sessionCacheKey(rec.playerId, rec.sessionId), rec);
      out.push(rec);
    }
    return out;
  }

  /**
   * Best-effort invite-code release: when the room reaches a terminal
   * phase (EXPIRED / ABANDONED / CANCELLED / COMPLETED) the code dies so
   * it can be reused. Called after every mutation path; a no-op while
   * the room is still live. Failures are swallowed — the room is already
   * terminal, and a stale code only fails closed at join time.
   */
  private async maybeUnregisterCode(): Promise<void> {
    if (!this.store) return;
    const phase = this.store.room.phase;
    if (
      phase !== 'EXPIRED' &&
      phase !== 'ABANDONED' &&
      phase !== 'CANCELLED' &&
      phase !== 'COMPLETED'
    ) {
      return;
    }
    try {
      const stub = this.env.CODE_REGISTRY_DO.get(
        this.env.CODE_REGISTRY_DO.idFromName('pakdam-code-registry'),
      );
      await stub.fetch('http://code-registry/op', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.env.DO_OP_SECRET
            ? { 'x-pakdam-op-secret': this.env.DO_OP_SECRET }
            : {}),
        },
        body: JSON.stringify({
          op: 'unregister',
          code: this.store.room.roomCode,
          roomId: this.store.room.roomId,
        }),
      });
    } catch {
      // Best effort only.
    }
  }

  // -- fan-out ---------------------------------------------------------------

  /**
   * Deliver outbound events to connected sockets. Per-recipient ping ack
   * (P2): a ping is acknowledged only for the seats that actually
   * received this broadcast — an offline Hunter's copy stays pending.
   */
  private async deliver(events: OutboundEvent[], nowMs: number): Promise<void> {
    if (!this.store) return;
    for (const event of events) {
      const text = JSON.stringify(serverEnvelope(this.store.room.roomId, event));
      const deliveredIds: string[] = [];
      for (const playerId of event.recipients) {
        for (const ws of this.ctx.getWebSockets(playerId)) {
          try {
            ws.send(text);
            if (!deliveredIds.includes(playerId)) deliveredIds.push(playerId);
          } catch {
            // Socket died between lookup and send; close handling suspends.
          }
        }
      }
      if (event.type === 'ping' && deliveredIds.length > 0) {
        const ping = (event.payload['ping'] as { pingId?: string } | undefined);
        if (ping?.pingId) {
          this.store.acknowledgePingDeliveryFor(ping.pingId, deliveredIds, nowMs);
        }
      }
    }
  }

  private async sendToPlayer(
    playerId: string,
    type: WsServerMessageType,
    payload: Record<string, unknown>,
    nowMs: number,
  ): Promise<void> {
    if (!this.store) return;
    const event = this.store.emit(type, payload, [playerId], nowMs);
    await this.deliver([event], nowMs);
  }

  // -- HTTP entry (Worker -> DO internal API) ---------------------------------

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    await this.load();

    if (req.headers.get('Upgrade') === 'websocket' && url.pathname === '/ws') {
      return this.handleUpgrade(req);
    }
    if (url.pathname !== '/op' || req.method !== 'POST') {
      return json({ ok: false, error: 'Not found.', code: 'NOT_FOUND', status: 404 }, 404);
    }

    // Worker<->DO shared secret (P2): the Worker sends it on every
    // internal /op call; the DO rejects without it when configured.
    // When DO_OP_SECRET is unset (dev) the check is skipped — the
    // founder must set it in production (`wrangler secret put
    // DO_OP_SECRET`) for enforcement.
    const configuredSecret = this.env.DO_OP_SECRET;
    if (configuredSecret) {
      if (req.headers.get('x-pakdam-op-secret') !== configuredSecret) {
        return json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN', status: 403 }, 403);
      }
    }

    const capped = await readCappedBody(req);
    if (!capped.ok) return capped.response;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(capped.text) as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: 'Invalid JSON body.', code: 'VALIDATION_FAILED', status: 400 }, 400);
    }
    const op = body['op'];
    if (typeof op !== 'string') {
      return json({ ok: false, error: 'Missing op.', code: 'VALIDATION_FAILED', status: 400 }, 400);
    }
    return this.dispatchOp(op, body);
  }

  private async dispatchOp(op: string, body: Record<string, unknown>): Promise<Response> {
    const nowMs = Date.now();
    const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    const num = (v: unknown): number => (typeof v === 'number' ? v : nowMs);

    // Create is the only op that works without an existing room.
    if (op === 'create') {
      if (this.store) {
        return json({ ok: false, error: 'Room already exists.', code: 'CONFLICT', status: 409 }, 409);
      }
      const required = ['roomId', 'roomCode', 'hostPlayerId', 'displayName', 'config', 'reconnectTokenHash', 'hostTokenHash'];
      for (const k of required) {
        if (body[k] === undefined) {
          return json({ ok: false, error: `Missing field: ${k}.`, code: 'VALIDATION_FAILED', status: 400 }, 400);
        }
      }
      const { store, persist } = RoomStore.createRoom({
        roomId: body['roomId'] as string,
        roomCode: body['roomCode'] as string,
        hostPlayerId: body['hostPlayerId'] as string,
        displayName: body['displayName'] as string,
        config: body['config'] as never,
        reconnectTokenHash: body['reconnectTokenHash'] as string,
        hostTokenHash: body['hostTokenHash'] as string,
        nowMs,
      });
      this.store = store;
      this.ctx.waitUntil(executePersistIntents(this.env as SupabaseEnv, persist));
      await this.save();
      await this.armAlarm();
      return json({
        ok: true,
        roomId: store.room.roomId,
        roomCode: store.room.roomCode,
        hostPlayerId: store.room.hostPlayerId,
        phase: store.room.phase,
      }, 201);
    }

    if (!this.store) {
      // P1-15 intake validation ops answer even without a room: a
      // nonexistent room is `exists: false`, never an error.
      if (op === 'room-exists') {
        return json({ ok: true, exists: false });
      }
      if (op === 'check-member') {
        return json({ ok: true, member: false });
      }
      return json({ ok: false, error: 'Room not found.', code: 'ROOM_NOT_FOUND', status: 404 }, 404);
    }
    const store = this.store;
    const playerId = asString(body['playerId']);
    const reconnectTokenHash = asString(body['reconnectTokenHash']);
    const hostTokenHash = asString(body['hostTokenHash']);

    switch (op) {
      case 'room-exists': {
        // P1-15: intake validation — does this room exist at all? No
        // credential needed; a room id is a random UUID, not a secret.
        return json({ ok: true, exists: true });
      }
      case 'check-member': {
        // P1-15: is this playerId an active seat in the room? No
        // credential — membership existence only, no state is revealed.
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        const seat = store.player(playerId);
        return json({ ok: true, member: seat !== undefined && seat.leftAt === null });
      }
      case 'add-player': {
        const r = await store.addPlayerAsync({
          displayName: asString(body['displayName']) ?? '',
          roomCode: asString(body['roomCode']) ?? '',
          reconnectTokenHash,
          nowMs,
        });
        if (!r.ok) return json({ ok: false, error: r.error, code: r.code }, r.status);
        await this.afterMutation(r.events, r.persist);
        // addPlayerAsync already returns the subject's PlayerView (hash
        // stripped) — pass it through, do not re-derive from a raw Player.
        return json({
          ok: true,
          player: r.value.player,
          reconnectToken: r.value.reconnectToken,
          restored: r.value.restored,
        });
      }
      case 'verify-reconnect': {
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        const valid = store.verifyReconnect(playerId, reconnectTokenHash) !== null;
        return json({ ok: true, valid });
      }
      case 'verify-host-token': {
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        const valid = store.verifyHost(playerId, hostTokenHash) !== null;
        return json({ ok: true, valid });
      }
      case 'issue-host-token': {
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        const r = await store.issueHostToken({ playerId, reconnectTokenHash, nowMs });
        if (!r.ok) return json({ ok: false, error: r.error, code: r.code }, r.status);
        await this.save();
        return json({ ok: true, hostToken: r.value.hostToken });
      }
      case 'transfer-host': {
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        const r = store.transferHost({
          playerId,
          hostTokenHash,
          newHostPlayerId: asString(body['newHostPlayerId']) ?? '',
          nowMs,
        });
        if (!r.ok) return json({ ok: false, error: r.error, code: r.code }, r.status);
        await this.afterMutation(r.events, r.persist);
        return json({ ok: true, ...r.value });
      }
      case 'start': {
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        const r = store.startMatch({ playerId, hostTokenHash, nowMs });
        if (!r.ok) return json({ ok: false, error: r.error, code: r.code }, r.status);
        await this.afterMutation(r.events, r.persist);
        return json({ ok: true, ...r.value });
      }
      case 'update-config': {
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        const r = store.updateConfig({ playerId, hostTokenHash, config: body['config'], nowMs });
        if (!r.ok) return json({ ok: false, error: r.error, code: r.code }, r.status);
        await this.afterMutation(r.events, r.persist);
        return json({ ok: true, room: r.value.room });
      }
      case 'remove-player': {
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        const r = store.removePlayer({
          playerId,
          hostTokenHash,
          targetPlayerId: asString(body['targetPlayerId']) ?? '',
          nowMs,
        });
        if (!r.ok) return json({ ok: false, error: r.error, code: r.code }, r.status);
        await this.afterMutation(r.events, r.persist);
        await this.disconnectPlayers(r.disconnect ?? []);
        return json({ ok: true, ...r.value });
      }
      case 'regenerate-code': {
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        const r = store.regenerateCode({ playerId, hostTokenHash, newCode: asString(body['newCode']) ?? '', nowMs });
        if (!r.ok) return json({ ok: false, error: r.error, code: r.code }, r.status);
        await this.afterMutation(r.events, r.persist);
        return json({ ok: true, ...r.value });
      }
      case 'get-catch-token': {
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        const r = await store.getCatchToken({
          playerId,
          reconnectTokenHash,
          catchId: asString(body['catchId']) ?? '',
          nowMs,
        });
        if (!r.ok) {
          // A failed token fetch can still carry sweep side effects (an
          // overdue catch expired as a side effect): deliver + persist
          // them before answering the error.
          const sideEvents = r.events ?? [];
          const sidePersist = r.persist ?? [];
          if (sideEvents.length > 0 || sidePersist.length > 0) {
            await this.afterMutation(sideEvents, sidePersist);
          }
          return json({ ok: false, error: r.error, code: r.code }, r.status);
        }
        await this.afterMutation(r.events, r.persist);
        return json({ ok: true, ...r.value });
      }
      case 'resolve-catch': {
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        const decision = body['decision'];
        if (decision !== 'confirmed' && decision !== 'rejected') {
          return json({ ok: false, error: "decision must be 'confirmed' or 'rejected'.", code: 'VALIDATION_FAILED', status: 400 }, 400);
        }
        const r = store.resolveCatchOp({
          playerId,
          hostTokenHash,
          catchId: asString(body['catchId']) ?? '',
          decision,
          reason: asString(body['reason']) ?? undefined,
          nowMs,
        });
        if (!r.ok) return json({ ok: false, error: r.error, code: r.code }, r.status);
        await this.afterMutation(r.events, r.persist);
        return json({ ok: true, ...r.value });
      }
      case 'lifecycle': {
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        const action = body['action'];
        if (action !== 'start' && action !== 'pause' && action !== 'resume' && action !== 'end') {
          return json({ ok: false, error: 'Unknown lifecycle action.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        }
        const r = store.lifecycleOp({
          action,
          playerId,
          hostTokenHash,
          reconnectTokenHash,
          nowMs,
        });
        if (!r.ok) return json({ ok: false, error: r.error, code: r.code }, r.status);
        await this.afterMutation(r.events, r.persist);
        return json({ ok: true, ...r.value });
      }
      case 'get-state': {
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        const r = store.getStateOp({ playerId, reconnectTokenHash, nowMs });
        if (!r.ok) return json({ ok: false, error: r.error, code: r.code }, r.status);
        return json({ ok: true, ...r.value });
      }
      case 'get-results': {
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        const r = store.resultsFor({ playerId, reconnectTokenHash, nowMs });
        if (!r.ok) return json({ ok: false, error: r.error, code: r.code }, r.status);
        return json({ ok: true, ...r.value });
      }
      case 'register-ticket': {
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        const purpose = body['purpose'];
        if (purpose !== 'connect' && purpose !== 'renew') {
          return json({ ok: false, error: "purpose must be 'connect' or 'renew'.", code: 'VALIDATION_FAILED', status: 400 }, 400);
        }
        const r = store.registerTicket({
          playerId,
          reconnectTokenHash,
          ticketId: asString(body['ticketId']) ?? '',
          ticketHash: asString(body['ticketHash']) ?? '',
          purpose,
          expiresAtMs: num(body['expiresAtMs']),
          nowMs,
        });
        if (!r.ok) {
          // Carry `retryAfterSeconds` through so the Worker can set the
          // `Retry-After` header on a DO-enforced rate limit.
          return json(
            { ok: false, error: r.error, code: r.code, retryAfterSeconds: r.retryAfterSeconds },
            r.status,
          );
        }
        return json({ ok: true, ...r.value });
      }
      case 'revoke-tickets': {
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        const r = store.revokeTickets({ playerId, reconnectTokenHash });
        if (!r.ok) return json({ ok: false, error: r.error, code: r.code }, r.status);
        return json({ ok: true, ...r.value });
      }
      default:
        return json({ ok: false, error: `Unknown op: ${op}.`, code: 'VALIDATION_FAILED', status: 400 }, 400);
    }
  }

  private async disconnectPlayers(
    list: Array<{ playerId: string; code: number; reason: string }>,
  ): Promise<void> {
    for (const d of list) {
      for (const ws of this.ctx.getWebSockets(d.playerId)) {
        try {
          ws.close(d.code, d.reason);
        } catch {
          // Already gone.
        }
      }
      // Seat-level removal: every tab's session goes (P1-4).
      await this.deleteSessionsForPlayer(d.playerId);
    }
  }

  // -- WS upgrade (DO side) ---------------------------------------------------

  /**
   * The Worker forwards ONLY the ticket SHA-256 in `x-pakdam-ticket-hash`.
   * The ticket VALUE never crosses the Worker -> DO boundary. Validation +
   * redeem happen here, atomically, in the room's DO.
   */
  private async handleUpgrade(req: Request): Promise<Response> {
    if (!this.store) {
      return json({ ok: false, error: 'Room not found.', code: 'ROOM_NOT_FOUND', status: 404 }, 404);
    }
    const ticketHash = req.headers.get('x-pakdam-ticket-hash');
    if (!ticketHash) {
      return json({ ok: false, error: 'Missing ticket.', code: 'TICKET_INVALID', status: 4401 }, 401);
    }
    const nowMs = Date.now();
    const redeemed = this.store.redeemTicketForConnect(ticketHash, nowMs);
    if (!redeemed.ok) {
      const status = redeemed.code === 'FORBIDDEN' ? 4403 : 4401;
      return json({ ok: false, error: redeemed.error, code: redeemed.code, status }, 401);
    }
    const { playerId, ticketId, expiresAtMs } = redeemed.value;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0] as WebSocket, pair[1] as WebSocket];
    // P1-4: each socket gets its own tab session — the tag carries the
    // seat AND the tab, so two tabs never share a session record.
    const sessionId = newId();
    this.ctx.acceptWebSocket(server, [playerId, `tab:${sessionId}`]);
    await this.putSession({
      sessionId,
      playerId,
      ticketId,
      ticketExpiresAtMs: expiresAtMs,
      renewalWarned: false,
      lastHeartbeatAtMs: nowMs,
      missedHeartbeats: 0,
      helloDone: false,
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  // -- WS message / close / error (hibernation API) -----------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.load();
    if (!this.store) {
      try {
        ws.close(4403, 'Room not found.');
      } catch {
        // Ignore.
      }
      return;
    }
    const nowMs = Date.now();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) as Record<string, unknown>;
    } catch {
      try {
        ws.close(4400, 'Malformed message.');
      } catch {
        // Ignore.
      }
      return;
    }
    const playerId = typeof data['playerId'] === 'string' ? (data['playerId'] as string) : null;
    const type = typeof data['type'] === 'string' ? (data['type'] as string) : '';
    if (!playerId || !type) {
      try {
        ws.close(4400, 'Message needs type and playerId.');
      } catch {
        // Ignore.
      }
      return;
    }
    // P0-3 (WS impersonation): the socket's REAL identity is the tag set
    // at upgrade from the redeemed ticket — never the envelope. Victim
    // playerIds are in every snapshot, so a client that claims another
    // seat's id must be rejected BEFORE any session lookup. The tag is
    // `[playerId, tab:<sessionId>]`; the tab tag also binds this message
    // to one tab's session record (P1-4).
    const tags = this.ctx.getTags(ws);
    const socketPlayerId = tags.find((t) => !t.startsWith('tab:')) ?? null;
    const tabTag = tags.find((t) => t.startsWith('tab:'));
    const tabSessionId = tabTag !== undefined ? tabTag.slice('tab:'.length) : undefined;
    if (socketPlayerId === null || socketPlayerId !== playerId) {
      const envelope = JSON.stringify({
        v: 1,
        type: 'error',
        roomId: this.store.room.roomId,
        payload: {
          code: 'FORBIDDEN',
          message: 'Socket identity does not match the message playerId.',
          retryable: false,
          serverTs: new Date(nowMs).toISOString(),
        },
      });
      try {
        ws.send(envelope);
      } catch {
        // Socket already gone; the close below still applies.
      }
      try {
        ws.close(4403, 'Socket identity does not match the message playerId.');
      } catch {
        // Ignore.
      }
      return;
    }
    const session = await this.getSession(playerId, tabSessionId);
    if (!session) {
      try {
        ws.close(4401, 'No session — reconnect with a fresh ticket.');
      } catch {
        // Ignore.
      }
      return;
    }
    const closeSocket = (code: number, reason: string): void => {
      try {
        ws.close(code, reason);
      } catch {
        // Ignore.
      }
    };

    // Heartbeat liveness (P2): only an actual `heartbeat` message — or a
    // location update, which proves the same thing — resets the timer.
    // Any other inbound traffic does NOT prove the socket is alive.
    if (type === 'heartbeat' || type === 'location.update') {
      session.lastHeartbeatAtMs = nowMs;
      session.missedHeartbeats = 0;
    }

    if (!session.helloDone) {
      if (type !== 'hello') {
        closeSocket(4400, 'hello must be the first message.');
        return;
      }
      const check = RoomStore.validateHello(data['payload']);
      if (!check.ok) {
        closeSocket(check.closeCode, check.error);
        return;
      }
      session.helloDone = true;
      await this.putSession(session);
      // Resume a suspended seat on hello / reconnect (P0-1).
      const resumed = this.store.resumeOnHello(playerId, nowMs);
      const welcome = this.store.emit(
        'welcome',
        { playerId, protocolVersion: 1 },
        [playerId],
        nowMs,
      );
      const snapshot = this.store.emit(
        'snapshot',
        this.store.snapshotFor(playerId, nowMs) as unknown as Record<string, unknown>,
        [playerId],
        nowMs,
      );
      await this.deliver([welcome, snapshot, ...resumed.events], nowMs);
      // A reconnected player re-receives pending (undelivered) pings
      // addressed to their role — a Hunter re-receives Runner pings, a
      // Runner re-receives Hunter pings. Delivered pings are never re-sent
      // (a reconnect loses earlier pings).
      const me = this.store.player(playerId);
      if (me) {
        for (const ping of this.store.pendingPingsFor(playerId, nowMs)) {
          const ev = this.store.emit('ping', { ping }, [playerId], nowMs);
          await this.deliver([ev], nowMs);
        }
      }
      if (resumed.persist.length > 0) {
        this.ctx.waitUntil(executePersistIntents(this.env as SupabaseEnv, resumed.persist));
      }
      await this.save();
      await this.armAlarm();
      return;
    }

    // A socket past its ticket expiry is closed 4401 — except auth.refresh,
    // which carries the NEW renewal ticket.
    if (type !== 'auth.refresh' && nowMs > session.ticketExpiresAtMs) {
      closeSocket(4401, 'Ticket expired — fetch a fresh ticket and reconnect once.');
      return;
    }

    if (type === 'auth.refresh') {
      const ticket = (data['payload'] as Record<string, unknown> | undefined)?.['ticket'];
      if (typeof ticket !== 'string') {
        closeSocket(4401, 'auth.refresh needs a ticket.');
        return;
      }
      const ticketHash = await hashWsTicket(ticket);
      const renewed = this.store.redeemTicketForRenew(ticketHash, playerId, nowMs);
      if (!renewed.ok) {
        closeSocket(4401, renewed.error);
        return;
      }
      session.ticketId = renewed.value.ticketId;
      session.ticketExpiresAtMs = renewed.value.expiresAtMs;
      session.renewalWarned = false;
      await this.putSession(session);
      await this.sendToPlayer(
        playerId,
        'auth.refreshed',
        { expiresAt: renewed.value.expiresAtMs, serverTs: new Date(nowMs).toISOString() },
        nowMs,
      );
      return;
    }

    const result = await this.store.handleWsMessage(
      { playerId, sessionId: session.sessionId },
      {
        type,
        commandId: typeof data['commandId'] === 'string' ? (data['commandId'] as string) : undefined,
        payload: (data['payload'] as Record<string, unknown> | undefined) ?? {},
      },
      nowMs,
    );
    await this.putSession(session);
    await this.deliver(result.events, nowMs);
    if (result.persist.length > 0) {
      this.ctx.waitUntil(executePersistIntents(this.env as SupabaseEnv, result.persist));
    }
    if (result.close) {
      // P1-4: leaving/closing removes THIS tab's session only — a second
      // tab's session (and socket) is untouched. The seat itself left,
      // so the other tab's next message gets a 4403 close.
      await this.deleteSession(playerId, session.sessionId);
      closeSocket(result.close.code, result.close.reason);
    }
    await this.maybeWarnRenewal(session, nowMs);
    await this.save();
    await this.armAlarm();
    await this.maybeUnregisterCode();
  }

  /** Warn once when the socket's ticket expires within 30 s. */
  private async maybeWarnRenewal(session: SessionRecord, nowMs: number): Promise<void> {
    if (session.renewalWarned) return;
    if (session.ticketExpiresAtMs - nowMs > RENEWAL_WARNING_MS) return;
    session.renewalWarned = true;
    await this.putSession(session);
    await this.sendToPlayer(
      session.playerId,
      'ticket.renewal-required',
      { expiresAt: session.ticketExpiresAtMs },
      nowMs,
    );
  }

  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.load();
    if (!this.store) return;
    await this.suspendClosedSeats(Date.now());
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    await this.load();
    if (!this.store) return;
    await this.suspendClosedSeats(Date.now());
  }

  /**
   * Socket close marks the seat suspended — NEVER removal, and NEVER
   * while another tab's socket is still alive (P1-4). A close event does
   * not name its seat, so sweep every session: a tab with no remaining
   * socket loses its record; a seat with no remaining socket at all is
   * suspended. A surviving tab's reconnect no longer races this sweep.
   */
  private async suspendClosedSeats(nowMs: number): Promise<void> {
    if (!this.store) return;
    const sessions = await this.listSessions();
    const events: OutboundEvent[] = [];
    const persist: PersistIntent[] = [];
    for (const session of sessions) {
      const seat = this.store.player(session.playerId);
      if (!seat || seat.leftAt !== null) {
        await this.deleteSessionsForPlayer(session.playerId);
        continue;
      }
      // This tab is gone only when its own tag has no socket left.
      if (this.ctx.getWebSockets(`tab:${session.sessionId}`).length > 0) continue;
      await this.deleteSession(session.playerId, session.sessionId);
      // Suspend only when NO socket remains for the whole seat.
      if (this.ctx.getWebSockets(session.playerId).length > 0) continue;
      const r = this.store.suspendSeat(session.playerId, 'network-lost', nowMs);
      events.push(...r.events);
      persist.push(...r.persist);
    }
    if (events.length > 0) await this.deliver(events, nowMs);
    if (persist.length > 0) {
      this.ctx.waitUntil(executePersistIntents(this.env as SupabaseEnv, persist));
    }
    await this.save();
    await this.armAlarm();
  }

  // -- alarm ---------------------------------------------------------------------

  async alarm(): Promise<void> {
    await this.load();
    if (!this.store) return;
    const nowMs = Date.now();
    const tick = this.store.alarmTick(nowMs);
    await this.deliver(tick.events, nowMs);
    if (tick.persist.length > 0) {
      this.ctx.waitUntil(executePersistIntents(this.env as SupabaseEnv, tick.persist));
    }

    // Heartbeat + renewal checks for every live session.
    const sessions = await this.listSessions();
    for (const session of sessions) {
      if (!session.helloDone) continue;
      const missed = Math.floor((nowMs - session.lastHeartbeatAtMs) / HEARTBEAT_INTERVAL_MS);
      if (missed >= HEARTBEAT_MISSED_LIMIT) {
        // Dead socket: close it (1011, 'heartbeat timeout') so the client
        // reconnect path re-syncs via snapshot; the seat is suspended.
        // 1006 is reserved (RFC 6455 §7.4) and must never be sent. Only
        // THIS tab's sockets close (P1-4) — a second tab is unaffected —
        // and the seat suspends only when no socket remains for it.
        for (const ws of this.ctx.getWebSockets(`tab:${session.sessionId}`)) {
          try {
            ws.close(1011, 'heartbeat timeout');
          } catch {
            // Already gone.
          }
        }
        await this.deleteSession(session.playerId, session.sessionId);
        if (this.ctx.getWebSockets(session.playerId).length > 0) continue;
        const r = this.store.suspendSeat(session.playerId, 'heartbeat-timeout', nowMs);
        await this.deliver(r.events, nowMs);
        if (r.persist.length > 0) {
          this.ctx.waitUntil(executePersistIntents(this.env as SupabaseEnv, r.persist));
        }
        continue;
      }
      session.missedHeartbeats = missed;
      await this.putSession(session);
      await this.maybeWarnRenewal(session, nowMs);
    }

    await this.save();
    await this.armAlarm();
    await this.maybeUnregisterCode();
  }
}

// ---------------------------------------------------------------------------
// CodeRegistryDO — invite-code -> roomId, single owner
// ---------------------------------------------------------------------------

export class CodeRegistryDO implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return json({ ok: false, error: 'Method not allowed.', code: 'VALIDATION_FAILED', status: 405 }, 405);
    }
    // Same Worker<->DO shared secret as the room DO (P2); skipped when
    // DO_OP_SECRET is unset (dev).
    const configuredSecret = this.env.DO_OP_SECRET;
    if (configuredSecret) {
      if (req.headers.get('x-pakdam-op-secret') !== configuredSecret) {
        return json({ ok: false, error: 'Forbidden.', code: 'FORBIDDEN', status: 403 }, 403);
      }
    }
    const capped = await readCappedBody(req);
    if (!capped.ok) return capped.response;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(capped.text) as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: 'Invalid JSON body.', code: 'VALIDATION_FAILED', status: 400 }, 400);
    }
    const op = body['op'];
    const code = typeof body['code'] === 'string' ? (body['code'] as string) : '';
    const roomId = typeof body['roomId'] === 'string' ? (body['roomId'] as string) : '';

    if (op === 'register') {
      if (!code || !roomId) {
        return json({ ok: false, error: 'register needs code and roomId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
      }
      const existing = await this.ctx.storage.get<string>(`code:${code}`);
      if (existing !== undefined && existing !== roomId) {
        return json({ ok: false, error: 'That room code is already taken.', code: 'CONFLICT', status: 409 }, 409);
      }
      await this.ctx.storage.put(`code:${code}`, roomId);
      return json({ ok: true, code, roomId });
    }
    if (op === 'lookup') {
      if (!code) {
        return json({ ok: false, error: 'lookup needs code.', code: 'VALIDATION_FAILED', status: 400 }, 400);
      }
      const found = await this.ctx.storage.get<string>(`code:${code}`);
      if (found === undefined) {
        return json({ ok: false, error: 'No live room for that code.', code: 'ROOM_NOT_FOUND', status: 404 }, 404);
      }
      return json({ ok: true, roomId: found, roomCode: code });
    }
    if (op === 'unregister') {
      if (!code || !roomId) {
        return json({ ok: false, error: 'unregister needs code and roomId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
      }
      const existing = await this.ctx.storage.get<string>(`code:${code}`);
      if (existing === roomId) {
        await this.ctx.storage.delete(`code:${code}`);
        return json({ ok: true, removed: true });
      }
      return json({ ok: true, removed: false });
    }
    return json({ ok: false, error: `Unknown op: ${String(op)}.`, code: 'VALIDATION_FAILED', status: 400 }, 400);
  }
}
