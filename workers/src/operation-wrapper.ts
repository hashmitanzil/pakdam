/**
 * @pakdam/workers — operation wrapper (v29, Reliability Gap 2, spec §3).
 *
 * The idempotency + rate-limit + cached-reply PROLOGUE and the
 * cached-reply EPILOGUE, extracted verbatim from
 * `RoomStore.handleWsMessage` (behaviour unchanged — the extraction
 * is a move, not a rewrite). One call site: the prologue/epilogue
 * are shared pre-/post-switch code in `handleWsMessage`, so there is
 * no per-case wrapper to apply — the six named ops (catch.request,
 * catch.confirm, catch.self-confirm, catch.runner-token, ready.set,
 * safety.pause / safety.resume) are the verified-covered set, and
 * every other mutating op gets the same prologue for free because it
 * runs through the same call site. Non-mutating messages
 * (heartbeat, location.update, snapshot.request, resync.request,
 * voice.signal) skip it, as before.
 *
 * CONTRACT (non-negotiable):
 * - A duplicate key returns the CACHED result, never an error. There
 *   is no IDEMPOTENCY_CONFLICT anywhere in this codebase.
 * - The wrapper respects the durable / non-durable split: it never
 *   calls `save()`, never decides durability, never writes a persist
 *   intent. Durability stays the caller's decision (the
 *   `persist.length > 0 || stateDirty` return in `handleWsMessage`).
 * - Keys are generated once per user action, by the client. The
 *   wrapper mints nothing — no `Date.now()` in key generation, no
 *   server-side key. A retry reuses the client's `commandId`.
 * - The cached reply is delivered ONLY to the replaying player
 *   (recipients narrowed to that seat), so a broadcast op is never
 *   re-broadcast to the whole room on a retry. Only events addressed
 *   to the replier are cached (a direct event to the replier, or a
 *   broadcast the replier was among — its payload is identical for
 *   every recipient). Per-viewer events for OTHER seats are never
 *   cached.
 * - Early returns (seat missing / left / rate-limited) cache their
 *   error reply too, via `operationCacheEarlyReply` — a retry then
 *   reaches the cached error instead of an empty `[]` that looks
 *   like success (Phase 4 (q)).
 */
import { isDuplicateCommand, rememberCommand } from '@pakdam/engine';
// Type-only import (erased at runtime — no circular import):
// `RoomMemory` / `OutboundEvent` live in room-do.ts, which imports
// this module for the runtime helpers above.
import type { OutboundEvent, RoomMemory } from './room-do.js';

/** The message types that carry no mutation to dedupe (canonical set). */
export const OPERATION_NON_MUTATING_TYPES: ReadonlySet<string> = new Set([
  'heartbeat',
  'location.update',
  'snapshot.request',
  'resync.request',
  'voice.signal',
]);

export interface OperationPrologueResult {
  /** True when this is a replay: return `cached` and do nothing else. */
  duplicate: boolean;
  /** The cached reply, recipients already narrowed to this seat. */
  cached: OutboundEvent[];
}

/**
 * Idempotency prologue. For a mutating message with a commandId:
 * a duplicate returns the cached reply; a first sight records the
 * commandId (in place — no map copy per message). Non-mutating
 * messages and messages without a commandId pass through untouched.
 */
export function operationPrologue(
  mem: RoomMemory,
  playerId: string,
  type: string,
  commandId: string | undefined,
  nowMs: number,
): OperationPrologueResult {
  if (OPERATION_NON_MUTATING_TYPES.has(type)) return { duplicate: false, cached: [] };
  if (typeof commandId !== 'string' || commandId.length === 0) {
    return { duplicate: false, cached: [] };
  }
  if (isDuplicateCommand(mem.idempotency, playerId, commandId, nowMs)) {
    const cached = mem.idempotentReplies.get(`${playerId}:${commandId}`) ?? [];
    const narrowed = cached.map((e) => ({ ...e, recipients: [playerId] }));
    return { duplicate: true, cached: narrowed };
  }
  rememberCommand(mem.idempotency, playerId, commandId, nowMs);
  return { duplicate: false, cached: [] };
}

/**
 * Cached-reply epilogue: record the reply a mutating op produced, so
 * a same-commandId retry gets the ACTUAL reply (broadcast events
 * included), never an empty `[]`. No-op for non-mutating messages
 * (they never recorded a commandId) and for messages without one.
 */
export function operationEpilogue(
  mem: RoomMemory,
  playerId: string,
  type: string,
  commandId: string | undefined,
  events: OutboundEvent[],
): void {
  if (OPERATION_NON_MUTATING_TYPES.has(type)) return;
  if (typeof commandId !== 'string' || commandId.length === 0) return;
  mem.idempotentReplies.set(
    `${playerId}:${commandId}`,
    events.filter(
      (e) =>
        (e.recipients.length === 1 && e.recipients[0] === playerId) ||
        (e.recipients.length > 1 && e.recipients.includes(playerId)),
    ),
  );
}

/**
 * Cache an early return's error as its reply. The prologue has not
 * run yet for the seat-missing / left / rate-limit returns, so the
 * commandId is recorded here as well (calling `rememberCommand`
 * twice only refreshes `seenAtMs`, which is harmless). A retry then
 * reaches the cached error instead of an empty `[]`.
 */
export function operationCacheEarlyReply(
  mem: RoomMemory,
  playerId: string,
  type: string,
  commandId: string | undefined,
  events: OutboundEvent[],
  nowMs: number,
): void {
  if (OPERATION_NON_MUTATING_TYPES.has(type)) return;
  if (typeof commandId !== 'string' || commandId.length === 0) return;
  rememberCommand(mem.idempotency, playerId, commandId, nowMs);
  operationEpilogue(mem, playerId, type, commandId, events);
}
