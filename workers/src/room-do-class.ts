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
 * and pending pings persist with it (P1-5), while memory-only state
 * (fixes, rate windows, raw catch tokens) is rebuilt empty after a wake,
 * per the spec split. v18: there is no pending shrink preview to persist
 * (the founder removed the next-zone preview entirely).
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
  SAFETY_PAUSE_FAST_TICK_MS,
  hashWsTicket,
  newId,
  type WsServerMessageType,
} from '@pakdam/shared';
import {
  ABANDONED_IDLE_MS,
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
  /**
   * Phase 3 #1/#5 — alarm dedup: the last delay `armAlarm()` actually
   * set (or `null` after deleteAlarm, `undefined` before the first arm
   * / after an alarm fires). Re-setting the same delay only re-arms the
   * same tick, so it is skipped.
   */
  private lastAlarmDelayMs: number | null | undefined = undefined;
  /** Phase 3 #4 — next epoch ms the idempotency table may sync to storage. */
  private idempotencyPersistDueMs = 0;
  /**
   * Phase 4 (s) — first-tick-after-wake grace: true until the first
   * alarm() tick of this DO instance runs. Heartbeats move
   * lastHeartbeatAtMs in memory only (Phase 3 #1), so the stored copy
   * can be minutes stale after a DO eviction; without grace the first
   * tick computes missed >= HEARTBEAT_MISSED_LIMIT and closes 1011 +
   * suspends a live seat. A fresh instance starts true (an eviction
   * always creates a new instance), and alarm() consumes it — a wake
   * via a message does not, so the grace is still there when the tick
   * finally runs.
   */
  private firstAlarmTickAfterWake = true;
  /**
   * v23 fix round 1 (S3/S7): a load-time wipe of a deleted room is
   * attempted at most once per awake instance. The wipe re-runs the
   * cancel persist first (the record must land before the room is
   * destroyed); while Supabase is down the room stays CANCELLED +
   * deleted in storage — still 404ing everything — and the next wake
   * (a fresh instance) retries. Without the flag, every request to a
   * deleted room would pay two Supabase round trips inside
   * `blockConcurrencyWhile`.
   */
  private deletedWipeAttempted = false;

  /**
   * v24 — the `endsAtMs` a grace one-shot alarm is currently armed
   * for, if any (memory only — the alarm itself lives in DO storage).
   * `null` means no grace one-shot is pending. Reset whenever an
   * alarm fires (`alarm()`), and cleared whenever the regular cadence
   * is re-armed over it (`armAlarm()`).
   */
  private graceAlarmEndsAtMs: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  // -- state ---------------------------------------------------------------

  /**
   * v29 (R13) — what the code shows about hibernation. A Durable
   * Object hibernates between requests when it has no pending work:
   * the instance (and all of `RoomStore`'s memory — `mem`, the
   * idempotency maps, the log buffer, the HTTP reply cache) is
   * dropped, and the next request re-creates it from durable storage
   * (`STATE_KEY` via `load()` + `restoreDurableMemory()`). What
   * survives: the room state, the ticket registry, pending pings,
   * the idempotency table (synced at most once/min), the host grace
   * and the 30 s return deadlines (both durable, both written on
   * transitions only), the idle clock. What does NOT survive: the
   * GPS fix history / violation counters, the log buffer (unflushed
   * entries are lost), the HTTP idempotency cache (a retry after a
   * wake re-executes), the safety-valve clock (re-arms on wake).
   * WebSocket attachments survive hibernation (hibernatable sockets
   * — the runtime re-attaches them on wake); `firstAlarmTickAfterWake`
   * exists precisely because stored heartbeat timestamps go stale
   * across a wake. The alarm is re-armed on every mutation
   * (`armAlarm`, deduped on delay), so a hibernated DO still ticks.
   * UNKNOWN (needs the founder's Cloudflare dashboard — do not
   * invent): how long a DO stays warm before hibernating, CPU/memory
   * actually consumed per game, and whether any alarm was ever
   * delayed or dropped by the platform.
   */
  private async load(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.loaded) return;
      const raw = await this.ctx.storage.get<RoomDoState>(STATE_KEY);
      const restored = raw === undefined ? null : restoreState(raw);
      if (restored) {
        this.store = new RoomStore(restored, emptyMemory());
        // P1-5: tickets, idempotency + replies, pending pings and the
        // pending shrink preview survive the wake with the game state.
        // v29 (R5 fix round): `restoreDurableMemory` also re-stamps
        // the memory epoch (`mem.epochMs = Date.now()`), so the
        // snapshot key changes on every wake even when durable
        // `serverSeq` + watermark did not.
        this.store.restoreDurableMemory();
        // v29 (Gap 5) — DO wake is logged (a restore from durable
        // storage after an eviction). Hibernation itself has no
        // observable hook — there is no event for "going to sleep",
        // so only the wake is logged, never the sleep.
        this.store.queueLog({
          level: 'info',
          message: 'do.wake',
          roomId: this.store.room.roomId,
        });
        // v23 fix round 1 (S3): a restored room marked deleted is a
        // host cancel whose wipe never finished — a crash/eviction
        // after the cancel persist but before `deleteAll()`, or a
        // live-path abort when the persist failed (S7). Never serve
        // it: finish the wipe instead of waking to a live room. The
        // wipe itself re-runs the cancel persist first and only
        // destroys the room once the record has landed (see
        // `finishDeletedRoomWipe`) — a crash must never silently
        // destroy the room without its audit record.
        if (this.store.state.deleted === true) {
          await this.finishDeletedRoomWipe();
        }
      }
      this.loaded = true;
    });
  }

  private async save(): Promise<void> {
    if (!this.store) return;
    // P1-5: sync the durable-backed memory maps into the state first,
    // so the ticket registry / pending pings persist.
    this.store.syncDurableMemory();
    // Phase 3 #4: the idempotency table syncs at most once a minute, not
    // on every save — rebuilding those arrays on every save is O(n) on
    // the hot path. The first save after a load always syncs (due = 0).
    const nowMs = Date.now();
    if (nowMs >= this.idempotencyPersistDueMs) {
      this.store.syncIdempotencyMemory();
      this.idempotencyPersistDueMs = nowMs + 60_000;
    }
    await this.ctx.storage.put(STATE_KEY, durableSnapshot(this.store.state));
  }

  /**
   * v28 (Diya F7/F11) — the alarm cadence now takes attendance. The
   * old version returned 1000 ms for HEAD_START / ACTIVE /
   * SAFETY_PAUSED with no session or socket input at all, so a live
   * room with zero connected sockets alarmed 86,400×/day until a
   * terminal phase — the whole DO-cap incident. Now:
   * - Live phase + a running host grace → 1 s. The grace deadline
   *   must land on time (F10: the idle end must never cut a grace
   *   short), and live ticks expire it within a second.
   * - Live phase + at least one live socket → 1 s. A live game with
   *   players attached keeps its real-time tick — do not slow real
   *   gameplay.
   * - Live phase + NO live socket + NO running grace → 30 s. Nothing
   *   can act on a 1 s tick with nobody attached; the 30 s cadence
   *   still runs the idle-abandon clock (`alarm()`), the lobby-style
   *   grace expiry (there is none — a lapsed grace needs no fast
   *   tick: with no successor attached there is nobody to transfer
   *   to), and the RESOLVING backstop. A request to a dormant DO
   *   re-creates/wakes it, so nothing is lost.
   * - SAFETY_PAUSED is a live phase here on purpose (Zara A2 / Diya
   *   F11): a paused room with players attached still ticks 1 s
   *   (the host may resume at any moment), and a paused room with
   *   nobody attached drops to 30 s and is ended by the idle window.
   *   v28 fix round (Zara R2): the 1 s tick while paused is bounded
   *   — after SAFETY_PAUSE_FAST_TICK_MS (5 min) of continuous pause
   *   a room with sockets attached demotes to 30 s (the clock is
   *   frozen while paused, so it is the sole unbounded phase). Resume
   *   is message-driven and a running grace always holds 1 s, so the
   *   demotion delays nothing a player can feel.
   * Async because the socket count may list session storage once
   * after a wake (warm cache afterwards — see `liveSocketCount`).
   */
  private async alarmDelayMs(): Promise<number | null> {
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
      const graceEndsAtMs = this.store.hostGraceEndsAtMs();
      if (graceEndsAtMs !== null && Date.now() < graceEndsAtMs) {
        return 1000;
      }
      const liveSockets = await this.liveSocketCount();
      if (liveSockets === 0) return 30_000;
      // v28 fix round (Zara R2) — SAFETY_PAUSED demotion: the clock
      // is frozen while paused, so a paused room with a socket
      // attached is the sole unbounded 1 s phase (86,400 DO requests
      // / day for a room in which nothing happens). After
      // SAFETY_PAUSE_FAST_TICK_MS (5 min) of continuous pause the
      // tick demotes to the 30 s cadence. Nothing is lost: resume is
      // message-driven (`safety.resume` arrives on the socket, not
      // on the tick), a running grace always holds the 1 s tick
      // above, and the no-socket abandon path still ends the room if
      // everyone leaves. `pausedAt` is durable and stamped once per
      // pause, so the demotion survives a DO eviction; a null /
      // unparseable stamp (legacy state) keeps the fast tick.
      if (phase === 'SAFETY_PAUSED') {
        const pausedAtMs =
          this.store.room.pausedAt === null ? NaN : Date.parse(this.store.room.pausedAt);
        if (!Number.isNaN(pausedAtMs) && Date.now() - pausedAtMs >= SAFETY_PAUSE_FAST_TICK_MS) {
          return 30_000;
        }
      }
      return 1000;
    }
    // RESOLVING ticks at 30 s, not 1 s: the match clock has stopped and
    // nothing is live — "1 s while live" does not cover resolving.
    return 30_000;
  }

  /**
   * v28 — distinct seats with at least one attached WebSocket right
   * now. A socket always carries its seat's playerId tag (set at
   * upgrade from the redeemed ticket), so the session records are the
   * live set: a session whose seat has no socket is a dead tab, not a
   * live player. Uses the heartbeat cache while awake (no storage
   * read); after a wake it lists storage once, which also warms the
   * cache. A never-hello socket counts until the alarm's sweep closes
   * it (F12) — a socket that connected but never hello'd is closed
   * once its ticket is dead, so it can hold the 1 s tick for at most
   * ~60 s past its ticket, never forever.
   */
  private async liveSocketCount(): Promise<number> {
    const sessions = await this.sessionsForHeartbeatCheck();
    const live = new Set<string>();
    for (const session of sessions) {
      if (this.ctx.getWebSockets(session.playerId).length > 0) {
        live.add(session.playerId);
      }
    }
    return live.size;
  }

  private async armAlarm(): Promise<void> {
    const delay = await this.alarmDelayMs();
    // v24 — one-shot grace alarm (LOBBY and READY_CHECK): both phases
    // tick every 30 s, so a tick-only grace check could transfer up
    // to ~60 s after disconnect — the 30 s promise must hold in the
    // lobby too (within a few seconds). While a grace is running in
    // the lobby / ready-check, arm ONE alarm for the grace deadline
    // itself instead of the regular 30 s tick: the tick that fires at
    // the deadline expires the grace on time. `setAlarm` overwrites
    // whatever was pending, so this replaces the regular tick — the
    // tick at the deadline runs `alarmTick` (expiring the grace) and
    // `armAlarm()` at its end re-arms the regular 30 s cadence. Live
    // phases tick every 1 s, so they need no one-shot (tick expiry
    // lands within a second); RESOLVING never expires a grace, so it
    // gets none either. The one-shot must not stall live 1 s ticks: a
    // phase change to live re-arms below (the delay changes),
    // overwriting the one-shot with the 1 s cadence. If the grace is
    // cancelled (host returns) while the one-shot is pending, the
    // one-shot still fires once — a harmless tick (no grace to
    // expire) — and the re-arm below restores the regular cadence.
    // If the deadline is already past (DO woke after it), the alarm
    // fires ASAP.
    if (delay === 30_000 && this.store !== null && (this.store.room.phase === 'LOBBY' || this.store.room.phase === 'READY_CHECK')) {
      const endsAt = this.store.hostGraceEndsAtMs();
      if (endsAt !== null) {
        if (this.graceAlarmEndsAtMs !== endsAt) {
          await this.ctx.storage.setAlarm(Math.max(endsAt, Date.now()));
          this.graceAlarmEndsAtMs = endsAt;
          this.lastAlarmDelayMs = 30_000;
        }
        return;
      }
      // No grace running, but a grace one-shot may still be pending
      // (grace cancelled after it was armed): force a regular re-arm
      // below, which overwrites the stale one-shot.
      if (this.graceAlarmEndsAtMs !== null) {
        this.graceAlarmEndsAtMs = null;
        this.lastAlarmDelayMs = undefined;
      }
    } else if (this.graceAlarmEndsAtMs !== null && delay !== this.lastAlarmDelayMs) {
      // Away from the lobby cadence (e.g. lobby -> live): the regular
      // re-arm below overwrites the one-shot, so drop the tracking.
      this.graceAlarmEndsAtMs = null;
    }
    // Phase 3 #1/#5: skip re-arming when the delay is unchanged — the
    // already-set alarm fires at the same time anyway. Only a phase
    // change (1 s live <-> 30 s lobby) or a terminal phase re-arms.
    if (delay === this.lastAlarmDelayMs) return;
    if (delay === null) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Date.now() + delay);
    }
    this.lastAlarmDelayMs = delay;
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
      const key = this.sessionCacheKey(rec.playerId, rec.sessionId);
      // Phase 3 #1: the in-memory record is NEWER than the durable one
      // (heartbeat timers move in memory only now) — never clobber it
      // with the stale storage copy.
      const cached = this.sessions.get(key);
      if (cached) {
        out.push(cached);
        continue;
      }
      this.sessions.set(key, rec);
      out.push(rec);
    }
    // Sessions only in memory (created since the last list) are live too.
    for (const rec of this.sessions.values()) {
      if (!out.includes(rec)) out.push(rec);
    }
    return out;
  }

  /**
   * Sessions for the alarm's heartbeat check (Phase 3 #5): the in-memory
   * cache is the live source while the DO is awake, so a storage
   * `list()` on every 1 s tick is a wasted read. Storage is listed only
   * when the cache is empty — a fresh wake with live sockets.
   */
  private async sessionsForHeartbeatCheck(): Promise<SessionRecord[]> {
    if (this.sessions.size > 0) return [...this.sessions.values()];
    return this.listSessions();
  }

  /**
   * One raw call to the code-registry DO. Returns `{ ok, status }` —
   * `ok` is the HTTP outcome, so callers can tell a CONFLICT (the
   * code belongs to another room) from a transport failure (status
   * 0). Never throws.
   */
  private async registryCall(
    op: 'register' | 'unregister',
    code: string,
    roomId: string,
  ): Promise<{ ok: boolean; status: number }> {
    try {
      const stub = this.env.CODE_REGISTRY_DO.get(
        this.env.CODE_REGISTRY_DO.idFromName('pakdam-code-registry'),
      );
      const res = await stub.fetch('http://code-registry/op', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.env.DO_OP_SECRET
            ? { 'x-pakdam-op-secret': this.env.DO_OP_SECRET }
            : {}),
        },
        body: JSON.stringify({ op, code, roomId }),
      });
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  /**
   * Best-effort invite-code release: when the room reaches a terminal
   * phase (EXPIRED / ABANDONED / CANCELLED / COMPLETED) the code dies so
   * it can be reused. Called after every mutation path; a no-op while
   * the room is still live.
   *
   * v23 fix round 1 (S11): a failed unregister used to be swallowed
   * silently, burning that code permanently (the registry has no
   * TTL/expiry). Now it retries ONCE and, if it still fails, logs
   * the failure and returns false instead of pretending the code was
   * freed. A stale code only fails closed at join time (the lookup
   * resolves to a roomId whose DO is empty → 404), but the burn is
   * now visible in logs instead of silent. Returns true when the
   * code was released (or there was nothing to release).
   */
  private async maybeUnregisterCode(): Promise<boolean> {
    if (!this.store) return true;
    const phase = this.store.room.phase;
    if (
      phase !== 'EXPIRED' &&
      phase !== 'ABANDONED' &&
      phase !== 'CANCELLED' &&
      phase !== 'COMPLETED'
    ) {
      return true;
    }
    const code = this.store.room.roomCode;
    const roomId = this.store.room.roomId;
    let attempt = await this.registryCall('unregister', code, roomId);
    if (!attempt.ok) {
      attempt = await this.registryCall('unregister', code, roomId);
    }
    if (!attempt.ok) {
      console.error(
        `[pakdam] unregister of invite code ${code} for room ${roomId} failed after retry (status ${attempt.status}) — the code stays registered and cannot be reused until it is released.`,
      );
      return false;
    }
    return true;
  }

  /**
   * Rule 1 — host cancel deletes the room (founder decision
   * 2026-11-21). Called ONLY from the `lifecycle` / `end` op, after
   * `cancelMatch` has run (phase CANCELLED, result built, store
   * marked deleted, `room.deleted` signal emitted, match-result +
   * room-upsert persist). The order is load-bearing:
   *  0. `save()` FIRST — CANCELLED + `deleted=true` to DO storage
   *     (S3), so a crash/eviction after this point wakes to a
   *     deleted room (`load()` finishes the wipe) instead of a live
   *     one.
   *  1. Translate the `room.deleted` SIGNAL into the delivered
   *     stream, minted fresh here so the serverSeqs are monotonic:
   *     `match.cancelled` (with the result) FIRST, then the literal
   *     `room.deleted` signal itself, then the `room.state` notice
   *     (reason `'room-deleted'`) LAST. The store deliberately emits
   *     NO `match.cancelled` (v23 store contract); the class
   *     synthesises it from the signal's result payload. The
   *     store's signal event object is consumed, never delivered.
   *  2. Deliver the stream to live sockets while the store exists.
   *  3. AWAIT the Supabase persist (match-result PATCH + room-upsert)
   *     so the cancel record lands BEFORE the DO state is destroyed.
   *     The normal path fires persist via `waitUntil`; deletion must
   *     not race it. (S7) A failed intent gets ONE bounded retry;
   *     if it still fails the wipe ABORTS here — the room stays
   *     CANCELLED + `deleted=true` in storage and this returns
   *     `false`, so the lifecycle response reports `deleted:false`.
   *     The room already 404s everything; the next wake finishes
   *     the wipe once the record lands (see `load()`).
   *  4. Unregister the invite code (phase is CANCELLED, so
   *     `maybeUnregisterCode` runs) — the code is freed for reuse.
   *  5. Close every socket (1000, 'room deleted'): no reconnect, the
   *     room is gone and the client goes home.
   *  6. Wipe the Durable Object storage EXPLICITLY (session keys +
   *     state key, S9 — no `deleteAll()`, which could wipe a
   *     same-roomId create interleaving after the store was nulled)
   *     + delete the alarm, and drop the in-memory store/sessions.
   *     Any later op on this room id loads nothing and answers
   *     ROOM_NOT_FOUND (join-by-code already 404s at the registry,
   *     which no longer has the code). No `save()` runs after this —
   *     there is nothing left to save.
   *
   * Runs inside `blockConcurrencyWhile` (S4): no concurrent op can
   * interleave the delete sequence and mint credentials on the
   * deleted store, and no concurrent `afterMutation` `save()` can
   * re-persist state after the wipe.
   *
   * Supabase rows are NOT deleted: `match-result` is a PATCH to the
   * `rooms` row itself, so deleting the row would erase the cancel
   * record. The `rooms` row (phase CANCELLED + result) and the
   * `players` rows stay as the audit record. Nothing reads them for
   * live play — the DO is the authority and results travel in the
   * delivered `match.cancelled` event. Deletion mechanics: DO storage
   * wiped explicitly (session keys + state key, S9 — no `deleteAll`)
   * + code-registry unregister + sockets closed; Supabase kept
   * (marked CANCELLED with the result).
   *
   * Lobby cancel deletes the lobby too: LOBBY → CANCELLED is a legal
   * edge (`MATCH_PHASE_TRANSITIONS`), so `cancelMatch` runs unchanged
   * from the lobby and this method deletes the room the same way.
   */
  private async deleteRoomAfterHostCancel(
    events: OutboundEvent[],
    persist: PersistIntent[],
    nowMs: number,
  ): Promise<boolean> {
    if (!this.store) return false;
    const signal = events.find((e) => e.type === 'room.deleted');
    if (!signal) {
      // Defensive only: `cancelMatch` always emits the signal. If it
      // ever did not, fall back to the normal mutation path rather
      // than deleting a room nobody was told about.
      await this.afterMutation(events, persist);
      return false;
    }
    // v23 fix round 1 (S3): persist CANCELLED + `deleted=true` to DO
    // storage BEFORE anything is delivered — a crash/eviction after
    // this point wakes to a deleted room (`load()` finishes the wipe)
    // instead of resurrecting the room LIVE.
    await this.save();
    const result = signal.payload['result'] as unknown;
    const recipients = this.store.allPlayerIds();
    const stream: OutboundEvent[] = [
      this.store.emit('match.cancelled', { result }, recipients, nowMs),
      this.store.emit(
        'room.deleted',
        { result },
        recipients,
        nowMs,
      ),
      this.store.roomDeletedNotice(nowMs),
    ];
    await this.deliver(stream, nowMs);
    // Awaited, not waitUntil: the cancel record must land first.
    // v23 fix round 1 (S7): the persist is no longer fire-and-forget
    // here — `executePersistIntents` reports per-intent outcomes.
    // A failed intent gets ONE bounded retry; if it still fails, the
    // wipe ABORTS (the room stays CANCELLED + `deleted=true` in DO
    // storage — it already 404s everything — and the next wake
    // finishes the wipe once the record lands, see `load()`). The
    // caller reports `deleted:false` so the lifecycle caller knows
    // the delete did not complete. Never silently wipe without the
    // audit record.
    const outcomes = await executePersistIntents(this.env as SupabaseEnv, persist);
    if (outcomes.some((ok) => !ok)) {
      const failed = persist.filter((_, i) => !outcomes[i]);
      const retry = await executePersistIntents(this.env as SupabaseEnv, failed);
      if (retry.some((ok) => !ok)) {
        console.error(
          `[pakdam] cancel persist for room ${this.store.room.roomId} failed after retry — aborting the wipe; the room stays CANCELLED + deleted in DO storage until the record lands.`,
        );
        return false;
      }
    }
    await this.maybeUnregisterCode();
    for (const playerId of recipients) {
      for (const ws of this.ctx.getWebSockets(playerId)) {
        try {
          ws.close(1000, 'room deleted');
        } catch {
          // Already gone.
        }
      }
    }
    this.sessions.clear();
    await this.wipeRoomStorage();
    this.store = null;
    this.lastAlarmDelayMs = null;
    return true;
  }

  /**
   * v23 fix round 1 (S3/S7) — finish the wipe of a deleted room that
   * woke from storage (see `load()`). The cancel audit record must
   * land in Supabase BEFORE the room is destroyed: the persist is
   * re-run from the restored room (match-result + room-upsert are
   * idempotent replays of the same values) and the wipe only proceeds
   * when every intent reports success. A failure leaves the room
   * CANCELLED + deleted in storage — still 404ing everything — and
   * the next wake retries. At most one attempt per awake instance
   * (see `deletedWipeAttempted`).
   */
  private async finishDeletedRoomWipe(): Promise<void> {
    if (!this.store) return;
    if (this.deletedWipeAttempted) return;
    this.deletedWipeAttempted = true;
    const room = this.store.room;
    const persist: PersistIntent[] = [
      { kind: 'match-result', room },
      { kind: 'room-upsert', room },
    ];
    const outcomes = await executePersistIntents(this.env as SupabaseEnv, persist);
    if (outcomes.some((ok) => !ok)) {
      console.error(
        `[pakdam] load-time wipe of deleted room ${room.roomId} aborted: the cancel audit record did not land — the room stays CANCELLED + deleted in DO storage and the next wake retries.`,
      );
      return;
    }
    await this.maybeUnregisterCode();
    this.sessions.clear();
    await this.wipeRoomStorage();
    this.store = null;
    this.lastAlarmDelayMs = null;
  }

  /**
   * v23 fix round 1 (S9) — destroy exactly the keys RoomDO owns:
   * every `session:*` record plus the state key, plus the alarm.
   * There is deliberately NO `deleteAll()` here: the old code nulled
   * the in-memory store and then bulk-wiped, so a `create` for the
   * same roomId interleaving in that window succeeded in memory and
   * was then wiped by the in-flight `deleteAll()`. Explicit keys
   * cannot clobber a room created after them, and RoomDO stores
   * nothing else (tickets / idempotency / pings live inside the
   * state key). If a key delete throws, the in-memory store is
   * already nulled so this instance still answers ROOM_NOT_FOUND,
   * and a restored deleted room re-runs this wipe on the next wake.
   */
  private async wipeRoomStorage(): Promise<void> {
    const sessions = await this.ctx.storage.list({ prefix: 'session:' });
    for (const key of sessions.keys()) {
      try {
        await this.ctx.storage.delete(key);
      } catch {
        // Best effort per key; the state key below is the load-bearing one.
      }
    }
    try {
      await this.ctx.storage.delete(STATE_KEY);
    } catch {
      // Best effort only (see the doc comment above).
    }
    try {
      await this.ctx.storage.deleteAlarm();
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

  /**
   * v29 (Gap 4) — HTTP idempotency cache key for one op call. Joins
   * are keyed by room (the seat does not exist yet);
   * start/replay by seat + op. Returns null when the request carried
   * no usable key (absent, empty, or over 64 chars — the Worker
   * validates the same bounds; the DO re-validates because it can
   * also be called directly in tests).
   */
  private httpIdempotencyCacheKey(
    op: string,
    body: Record<string, unknown>,
    playerId: string | null,
  ): string | null {
    const key = body['idempotencyKey'];
    if (typeof key !== 'string' || key.length === 0 || key.length > 64) return null;
    if (op === 'add-player') {
      return `join:${this.store?.room.roomId ?? 'unknown'}:${key}`;
    }
    if (playerId === null) return null;
    return `${playerId}:${op}:${key}`;
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

    // v29 (Gap 4) — HTTP idempotency, phase 1 (join) + phase 2
    // (start/replay): a retried call with the same key returns the
    // cached reply with the original status — for join, including the
    // ORIGINAL reconnectToken. Only successes are cached (an error
    // must re-execute: the client may have fixed the input). The
    // cache is memory-only (the join reply carries a raw token, which
    // is never persisted) — a retry after a DO eviction re-executes
    // instead of replaying. Keys are client-minted once per user
    // action; a key reused across seats returns the first seat's
    // reply, so clients must mint a fresh UUID per action.
    const httpCacheKey =
      op === 'add-player' || op === 'start' || op === 'replay'
        ? this.httpIdempotencyCacheKey(op, body, playerId)
        : null;
    if (httpCacheKey !== null) {
      const cached = store.getHttpIdempotentReply(httpCacheKey, nowMs);
      if (cached !== null) return json(cached.body, cached.status);
    }

    switch (op) {
      case 'room-exists': {
        // P1-15: intake validation — does this room exist at all? No
        // credential needed; a room id is a random UUID, not a secret.
        // v23 fix round 1 (S10): a deleted room does not exist.
        return json({ ok: true, exists: store.state.deleted !== true });
      }
      case 'check-member': {
        // P1-15: is this playerId an active seat in the room? No
        // credential — membership existence only, no state is revealed.
        // v23 fix round 1 (S10): a deleted room has no members.
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        if (store.state.deleted === true) return json({ ok: true, member: false });
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
        const joinBody = {
          ok: true,
          player: r.value.player,
          reconnectToken: r.value.reconnectToken,
          restored: r.value.restored,
        };
        // v29 (Gap 4) — cache the success reply for the key (with the
        // ORIGINAL reconnectToken, so a lost-response retry does not
        // mint a second seat).
        if (httpCacheKey !== null) {
          store.putHttpIdempotentReply(httpCacheKey, 200, joinBody, nowMs);
        }
        return json(joinBody);
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
        const startBody = { ok: true, ...r.value };
        // v29 (Gap 4) — cache the success reply for the key.
        if (httpCacheKey !== null) {
          store.putHttpIdempotentReply(httpCacheKey, 200, startBody, nowMs);
        }
        return json(startBody);
      }
      case 'replay': {
        // v18: host-only reset of a finished room to LOBBY (same room /
        // code, fresh game). Terminal phases only — see
        // `RoomStore.replayMatch`.
        if (!playerId) return json({ ok: false, error: 'Missing playerId.', code: 'VALIDATION_FAILED', status: 400 }, 400);
        // v23 fix round 1 (S1): the invite code was unregistered when
        // the room reached its terminal phase, so a replayed lobby
        // would be unjoinable by code and unstartable until the old
        // host rejoined. Re-register the code BEFORE resetting —
        // register-then-replay (mirrors create): the registry is the
        // single owner, so once registered no other room can take
        // this code, and a replay that then fails rolls the
        // registration back. The host check runs first so a failed
        // host check never squats a code. (The deleted check first:
        // a deleted room refuses with 404, exactly as `replayMatch`
        // itself would — the host check below also refuses deleted
        // rooms, but as 403.)
        if (store.state.deleted === true) {
          return json({ ok: false, error: 'This room has been deleted.', code: 'ROOM_NOT_FOUND', status: 404 }, 404);
        }
        if (!store.verifyHost(playerId, hostTokenHash)) {
          return json({ ok: false, error: 'Only the host can replay the room.', code: 'FORBIDDEN' }, 403);
        }
        const code = store.room.roomCode;
        const roomId = store.room.roomId;
        const reg = await this.registryCall('register', code, roomId);
        if (!reg.ok) {
          return json(
            { ok: false, error: 'That invite code was reused by another room — the room cannot be replayed on it.', code: 'CONFLICT', status: 409 },
            409,
          );
        }
        const r = store.replayMatch({ playerId, hostTokenHash, nowMs });
        if (!r.ok) {
          await this.registryCall('unregister', code, roomId);
          return json({ ok: false, error: r.error, code: r.code }, r.status);
        }
        await this.afterMutation(r.events, r.persist);
        const replayBody = { ok: true, ...r.value };
        // v29 (Gap 4) — cache the success reply for the key.
        if (httpCacheKey !== null) {
          store.putHttpIdempotentReply(httpCacheKey, 200, replayBody, nowMs);
        }
        return json(replayBody);
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
        if (r.events.length === 0 && r.persist.length === 0) {
          // Cheap re-fetch (Phase 3 #10): a valid token already existed,
          // nothing mutated — answer without a full save + re-arm.
          return json({ ok: true, ...r.value });
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
        if (action === 'end') {
          // Rule 1 (founder decision 2026-11-21): a host cancel deletes
          // the room — no rejoin, no lobby page, no stale state, code
          // freed. `cancelMatch` already ran inside `lifecycleOp`
          // (host-only: a non-host gets 403 there) and emitted the
          // `room.deleted` signal; the delete routine translates it
          // into the delivered stream (`match.cancelled` →
          // `room.deleted` → `room.state` room-deleted), persists the
          // cancel record, then wipes the room.
          // v23 fix round 1 (S4): the whole end → delete sequence runs
          // inside `blockConcurrencyWhile` — no concurrent /op can
          // interleave it, mint credentials on the deleted store, or
          // re-persist state after the wipe via `afterMutation`.
          // (S7) The delete reports whether the wipe completed: when
          // the cancel persist failed after its retry, the room stays
          // CANCELLED + deleted in storage and `deleted:false` tells
          // the caller the delete did not complete.
          let deleted = false;
          await this.ctx.blockConcurrencyWhile(async () => {
            deleted = await this.deleteRoomAfterHostCancel(r.events, r.persist, nowMs);
          });
          return json({ ok: true, ...r.value, deleted });
        }
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
    // v23 fix round 1 (S4): a deleted room takes no new sockets — a
    // ticket minted before the delete must not open a socket after it.
    // (A restored deleted room is normally already wiped by `load()`;
    // this covers the in-flight delete window.)
    if (this.store.state.deleted === true) {
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
    // The timer moves in memory only (Phase 3 #1) — the stored copy
    // goes stale across a DO eviction, and the alarm's
    // first-tick-after-wake grace (Phase 4 (s)) is what keeps that
    // staleness from suspending a live seat.
    if (type === 'heartbeat' || type === 'location.update') {
      session.lastHeartbeatAtMs = nowMs;
      session.missedHeartbeats = 0;
    }

    // v29 (R10) — a repeat `hello` on an already-hello'd socket is
    // cheap and idempotent: the socket survived a route change (the
    // shared-socket client keeps one socket across routes), so there
    // is nothing to re-authenticate and no new ticket HTTP. Re-deliver
    // the welcome + snapshot (the same two events as the first hello),
    // resume if the seat was suspended (same as the first hello), and
    // return — no pending-ping re-send (nothing was lost: the socket
    // never dropped). Previously a repeat hello fell through to the
    // store's default case ("Unknown message type") — harmless, but
    // an error where a re-sync belongs.
    if (type === 'hello' && session.helloDone) {
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
      if (resumed.persist.length > 0) {
        this.ctx.waitUntil(executePersistIntents(this.env as SupabaseEnv, resumed.persist));
        await this.save();
      }
      await this.armAlarm();
      return;
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
        // Only a resume mutates durable state on hello; the welcome +
        // snapshot themselves are transient (Phase 3 #1).
        await this.save();
      }
      // armAlarm is a no-op when the delay is unchanged (dedup inside).
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
    // Phase 3 #1 — skip the durable path for non-durable messages: the
    // session record is written only when the message changed durable
    // state (a heartbeat / GPS fix / snapshot only moves in-memory
    // timers). Writing the session + full state blob + re-arming the
    // alarm on every message is what queued taps behind GPS fixes.
    // Game mutations (ready, catch, pause, leave, ...) still save.
    if (result.durable) await this.putSession(session);
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
    if (result.durable) {
      await this.save();
      await this.maybeUnregisterCode();
    }
    // armAlarm is a no-op when the delay is unchanged (dedup inside).
    await this.armAlarm();
  }

  /**
   * v29 (R8) — server-push ticket renewal (preferred over the HTTP
   * renew call). When the socket's ticket expires within 30 s
   * (`RENEWAL_WARNING_MS`), the DO mints + registers a fresh ticket
   * itself and pushes it over the existing authenticated socket as
   * `ticket.renewed` — the client stores it without an HTTP call and
   * uses it on its next reconnect. The current socket keeps working
   * until its own ticket expires; the client then reconnects with the
   * pushed ticket, no HTTP round trip. The old
   * `ticket.renewal-required` warning is still sent alongside, for
   * clients that have not implemented `ticket.renewed` yet — they
   * renew over HTTP as before. Mints once per ticket cycle
   * (`renewalWarned`); if minting fails (rate limit, seat gone),
   * only the warning goes out and the client falls back to HTTP
   * renew. The ticket record syncs to durable storage on the next
   * save — an eviction between mint and save loses the pushed
   * ticket, and the client falls back to HTTP renew on its 4401
   * (same as before). Acceptance for this build: 0 HTTP renewals in
   * the steady state (the ~30 s renewal cadence is unchanged).
   */
  private async maybeWarnRenewal(session: SessionRecord, nowMs: number): Promise<void> {
    if (session.renewalWarned) return;
    if (session.ticketExpiresAtMs - nowMs > RENEWAL_WARNING_MS) return;
    session.renewalWarned = true;
    await this.putSession(session);
    const seat = this.store?.player(session.playerId);
    if (seat !== undefined && seat.leftAt === null) {
      const minted = await this.store?.mintRenewalTicket(session.playerId, nowMs);
      if (minted !== undefined && minted.ok) {
        // v29 fix round (F2) — the payload carries `expiresAtMs`
        // (the 60 s TTL, never 10 min): without it the client cannot
        // know when the pushed ticket itself dies.
        await this.sendToPlayer(
          session.playerId,
          'ticket.renewed',
          { ticket: minted.value.ticket, expiresAtMs: minted.value.expiresAtMs },
          nowMs,
        );
      }
    }
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
    // v23 fix round 1 (S6): one batch id for the whole sweep — the
    // same-batch amend in `succeedHostAfterDisconnect` only ever
    // rewrites a transfer from THIS sweep. A later close sweep gets a
    // fresh id, so it can never amend this sweep's delivered transfer.
    const batchId = newId();
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
      // v23 Rule 2 (v24: grace-deferred): the host grace starts INSIDE
      // `suspendSeat` for the 'network-lost' reason (see the store) —
      // the sweep itself only suspends. No transfer happens here: the
      // transfer happens at grace expiry (`expireHostGrace`, from
      // `alarmTick`) if the host has not returned. Batching is
      // automatic: every seat in this sweep is suspended first (same
      // `nowMs`).
      const r = this.store.suspendSeat(session.playerId, 'network-lost', nowMs, batchId);
      events.push(...r.events);
      persist.push(...r.persist);
    }
    if (events.length > 0) await this.deliver(events, nowMs);
    if (persist.length > 0) {
      this.ctx.waitUntil(executePersistIntents(this.env as SupabaseEnv, persist));
    }
    // Phase 3 #1: a close that suspended nothing writes nothing.
    if (events.length > 0 || persist.length > 0) await this.save();
    await this.armAlarm();
  }

  // -- alarm ---------------------------------------------------------------------

  async alarm(): Promise<void> {
    await this.load();
    if (!this.store) return;
    // The alarm fired, so nothing is pending: force the re-arm at the end
    // (armAlarm dedups on the delay, so this reset is what re-arms).
    this.lastAlarmDelayMs = undefined;
    // v24: the fired alarm was the pending one — grace one-shot
    // included — so no one-shot is pending anymore. `armAlarm()` at
    // the end re-arms whatever is needed (a still-running grace gets
    // a fresh one-shot at its deadline).
    this.graceAlarmEndsAtMs = null;
    // Phase 4 (s) — consume the first-tick-after-wake grace (see the
    // field): a live socket at tick time proves the seat is alive far
    // better than the stale stored heartbeat timestamp does.
    const firstTickAfterWake = this.firstAlarmTickAfterWake;
    this.firstAlarmTickAfterWake = false;
    const nowMs = Date.now();
    // v18 fix round (A3/F4): the first tick after a wake skips the
    // missing-fix ejection (step (4a)) once — durable `lastFixAt` can
    // be > 30 s old for a whole live roster after a DO eviction, and
    // the first tick would otherwise mass-eject players whose phones
    // are alive and about to report. The heartbeat grace above uses
    // the same flag for the same reason.
    // v28 fix round (Zara R1) — the store-level abandon rule may only
    // fire with NO live socket at all (its invariant, matching the
    // class idle clock below). The count is observed here, at tick
    // start, and passed in: the store cannot see sockets itself.
    // A missing count fails the rule closed, so the class is the only
    // production caller and must always pass it.
    const liveSocketsAtTickStart = await this.liveSocketCount();
    const tick = this.store.alarmTick(nowMs, {
      firstTickAfterWake,
      liveSocketCount: liveSocketsAtTickStart,
    });
    await this.deliver(tick.events, nowMs);
    if (tick.persist.length > 0) {
      this.ctx.waitUntil(executePersistIntents(this.env as SupabaseEnv, tick.persist));
    }

    // Heartbeat + renewal checks for every live session. The storage
    // list() runs only when the in-memory cache is empty (a fresh wake);
    // while awake the cache IS the live session set (Phase 3 #5).
    const sessions = await this.sessionsForHeartbeatCheck();
    let sessionDirty = false;
    // v23 fix round 1 (S2): heartbeat-timeout suspends are COLLECTED
    // across the whole tick and delivered ONCE after the loop — never
    // per-session inside it. The loop used to `deliver()` each
    // `suspendSeat` result immediately, so the first transfer
    // (H→P2) was already on the wire before the second suspend ran,
    // and the same-batch amend rewrote an object `deliver()` had
    // already serialised with JSON.stringify — changing nothing.
    // Collect-then-deliver (mirroring `suspendClosedSeats`) is what
    // makes the amend real. What else the loop delivers per-session:
    // only `maybeWarnRenewal` — a DIRECT `ticket.renewal-required`
    // to one seat about its own ticket, never a `host.transferred`,
    // never broadcast — so batching the suspend stream cannot change
    // it, and a warning arriving ahead of the suspend broadcast is
    // harmless (the broadcast's `room.state` triggers a snapshot
    // re-fetch anyway).
    const suspendEvents: OutboundEvent[] = [];
    const suspendPersist: PersistIntent[] = [];
    const batchId = newId();
    for (const session of sessions) {
      if (!session.helloDone) {
        // v28 (Diya F12) — never-hello sweep: a socket that connected
        // but never sent `hello` holds a redeemed ticket and, worse
        // for the idle fix, counts as a live socket forever (the
        // heartbeat check above skips it, and nothing else ever
        // closes it — no session TTL existed). The connect ticket
        // lives 60 s (`WS_TICKET_TTL_MS`); past it the socket can
        // never hello usefully, and the client contract already
        // closes an expired ticket 4401 (fresh ticket, reconnect
        // once) — so close it here (4401) and drop the session. A
        // client merely slow to hello (> 60 s) just reconnects with
        // a fresh ticket, exactly as on any expired ticket. Until
        // this sweep runs the socket holds the 1 s tick for at most
        // ~60 s past its ticket, never indefinitely.
        if (nowMs > session.ticketExpiresAtMs) {
          for (const ws of this.ctx.getWebSockets(`tab:${session.sessionId}`)) {
            try {
              ws.close(4401, 'Ticket expired — fetch a fresh ticket and reconnect once.');
            } catch {
              // Already gone.
            }
          }
          await this.deleteSession(session.playerId, session.sessionId);
          sessionDirty = true;
        }
        continue;
      }
      const missed = Math.floor((nowMs - session.lastHeartbeatAtMs) / HEARTBEAT_INTERVAL_MS);
      if (missed >= HEARTBEAT_MISSED_LIMIT) {
        // Phase 4 (s) — first-tick-after-wake grace: the stored
        // lastHeartbeatAtMs can be minutes stale after a DO eviction
        // (heartbeats move it in memory only), so a live seat would
        // otherwise be closed 1011 + suspended on the first tick even
        // though its client is alive and heartbeating. A socket still
        // attached for this seat proves it is alive: reset its clock
        // (and persist the fresh timestamp) instead of suspending.
        // A seat with NO socket attached gets no grace — a genuinely
        // dead seat still suspends on the first tick.
        if (firstTickAfterWake && this.ctx.getWebSockets(session.playerId).length > 0) {
          session.lastHeartbeatAtMs = nowMs;
          session.missedHeartbeats = 0;
          await this.putSession(session);
          sessionDirty = true;
          continue;
        }
        // v29 fix round (F5) — a suspended seat with a LIVE socket
        // attached is never closed 1011 and never starts a 30 s
        // window. The skip depends on SOCKET-ATTACHED state, not on
        // the memory-only `lastSuspensionReason` map: after a DO
        // eviction `restoreDurableMemory` does not restore that map,
        // so the old reason-gated guard let a merely-hidden tab's
        // live socket be closed 1011 after ~90 s of missed
        // heartbeats and `suspendSeat('heartbeat-timeout')` start a
        // 30 s ejection window for a player who never left. A live
        // socket is proof of life — the heartbeats stopped on
        // purpose (tab hidden), not a death — so reset the clock
        // (same shape as the first-tick-after-wake grace above) and
        // move on; the seat stays suspended. A suspended seat with
        // NO socket attached still times out below.
        const seat = this.store.player(session.playerId);
        if (
          seat !== undefined &&
          seat.connectionState === 'suspended' &&
          this.ctx.getWebSockets(session.playerId).length > 0
        ) {
          // v29 (H) — ghost-host investigation: NO server-side fix was
          // applied here, deliberately. A socket that died with NO
          // close event delivered would reset this clock forever and
          // leave a ghost host (no grace, no abandon — the idle path
          // counts the ghost socket as live). But a time bound on the
          // skip (e.g. "presume dead after 10 min of silence") is NOT
          // safe: a live hidden tab is INDISTINGUISHABLE from a dead
          // socket from the server — both are a listed socket with no
          // heartbeats — and the v28 Zara-R1 test pins that a hidden
          // host's socket is never closed 1011, even after 11 min.
          // A bound would close a live host who merely locked their
          // phone for 10 min and start a grace that could transfer
          // the crown away from a live player. The runtime is the
          // party that can tell a dead TCP from a quiet one: a dead
          // socket is removed from `getWebSockets()` and delivers
          // `webSocketClose`/`webSocketError` when the runtime
          // notices, and no evidence in this repo shows it failing
          // to. The safe fix direction is client-side (a hidden-tab
          // liveness proof, e.g. a ~60 s heartbeat while hidden —
          // Meera's side, and a battery/design call for the founder),
          // not a server-side time bound. So the skip stays
          // unconditional, exactly as v28 designed it; the residual
          // failure mode (a ghost host that never transfers and a
          // room the idle path can never abandon) is documented in
          // the v29 report as an open platform-assumption risk.
          session.lastHeartbeatAtMs = nowMs;
          session.missedHeartbeats = 0;
          await this.putSession(session);
          sessionDirty = true;
          continue;
        }
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
        // v23 Rule 2 (v24: grace-deferred): the host grace starts
        // INSIDE `suspendSeat` for the 'heartbeat-timeout' reason (see
        // the store). The first-tick-after-wake grace above already
        // spared live seats; a seat reaching this line is genuinely
        // dead. No transfer happens here: the transfer happens at
        // grace expiry (`expireHostGrace`, from `alarmTick`) if the
        // host has not returned. (S2: collected, delivered once after
        // the loop — the suspend broadcast still goes out once.)
        const r = this.store.suspendSeat(session.playerId, 'heartbeat-timeout', nowMs, batchId);
        suspendEvents.push(...r.events);
        suspendPersist.push(...r.persist);
        sessionDirty = true;
        continue;
      }
      // Only write the session when the missed count actually changed —
      // not on every 1 s tick (Phase 3 #5).
      if (session.missedHeartbeats !== missed) {
        session.missedHeartbeats = missed;
        await this.putSession(session);
        sessionDirty = true;
      }
      await this.maybeWarnRenewal(session, nowMs);
    }

    // v23 fix round 1 (S2): the collected heartbeat-timeout suspend
    // stream goes out ONCE, after the whole tick's suspends ran — so
    // a same-batch amend names the final host on the wire, exactly
    // once per batch.
    if (suspendEvents.length > 0) await this.deliver(suspendEvents, nowMs);
    if (suspendPersist.length > 0) {
      this.ctx.waitUntil(executePersistIntents(this.env as SupabaseEnv, suspendPersist));
    }

    // v28 — idle / abandoned-room handling (Diya F7/F8/F10/F11).
    // Runs AFTER the heartbeat loop above, so a seat just suspended
    // for timeout no longer counts as live. Precedence (F10): a
    // running host grace beats the idle clock — while the grace runs
    // the clock is left UNTOUCHED (neither set nor cleared) and the
    // room is never abandoned, so the idle end can never cut a 30 s
    // grace short. It only DEFERS: the clock resumes (or starts) on
    // the first tick after the grace lapses, and a host who returns
    // inside it revives the room cleanly (`resumeOnHello` cancels
    // the grace; the re-attached socket clears the clock below).
    // Only a room with NO live socket at all accrues idle time, and
    // only in a phase the idle end covers (live phases + READY_CHECK
    // / COUNTDOWN — see `abandonForIdle`); a LOBBY keeps its 24 h
    // expiry and a terminal phase is already done. The clock itself
    // is durable (`state.noSocketsSinceMs`): the DO is routinely
    // evicted between 30 s ticks, and a memory-only clock would
    // restart on every wake and never complete. It is written only
    // on transitions (first no-socket tick sets it, a live socket
    // clears it, abandonment clears it) — the quiet 30 s ticks in
    // between write nothing.
    const idleEvents: OutboundEvent[] = [];
    const idlePersist: PersistIntent[] = [];
    let idleChanged = false;
    {
      const phase = this.store.room.phase;
      const idlePhase =
        phase === 'HEAD_START' ||
        phase === 'ACTIVE' ||
        phase === 'SAFETY_PAUSED' ||
        phase === 'READY_CHECK' ||
        phase === 'COUNTDOWN';
      const graceEndsAtMs = this.store.hostGraceEndsAtMs();
      const graceRunning = graceEndsAtMs !== null && nowMs < graceEndsAtMs;
      const liveSockets = await this.liveSocketCount();
      if (liveSockets > 0) {
        if (this.store.state.noSocketsSinceMs !== null && this.store.state.noSocketsSinceMs !== undefined) {
          this.store.state.noSocketsSinceMs = null;
          idleChanged = true;
        }
      } else if (!idlePhase) {
        // Not a phase the idle end covers (LOBBY / terminal /
        // RESOLVING, which the backstop just completed): the clock
        // is meaningless here, keep the state clean.
        if (this.store.state.noSocketsSinceMs !== null && this.store.state.noSocketsSinceMs !== undefined) {
          this.store.state.noSocketsSinceMs = null;
          idleChanged = true;
        }
      } else if (graceRunning) {
        // F10: defer, do not reset — the clock is left exactly as
        // it was, and no abandonment is checked on this tick.
      } else {
        const since = this.store.state.noSocketsSinceMs;
        if (since === null || since === undefined) {
          this.store.state.noSocketsSinceMs = nowMs;
          idleChanged = true;
        } else if (nowMs - since >= ABANDONED_IDLE_MS) {
          const gone = this.store.abandonForIdle(nowMs);
          if (gone.abandoned) {
            idleEvents.push(...gone.events);
            idlePersist.push(...gone.persist);
            this.store.state.noSocketsSinceMs = null;
            idleChanged = true;
          }
        }
      }
    }
    if (idleEvents.length > 0) await this.deliver(idleEvents, nowMs);
    if (idlePersist.length > 0) {
      this.ctx.waitUntil(executePersistIntents(this.env as SupabaseEnv, idlePersist));
    }

    // Skip the save when the tick produced nothing durable: no events, no
    // persist, no session change. A quiet 1 s tick is then deliver-
    // nothing, write-nothing (Phase 3 #5).
    const changed = tick.events.length > 0 || tick.persist.length > 0 || sessionDirty || idleChanged || idleEvents.length > 0 || idlePersist.length > 0;
    if (changed) {
      await this.save();
      await this.maybeUnregisterCode();
    }
    await this.armAlarm();
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
