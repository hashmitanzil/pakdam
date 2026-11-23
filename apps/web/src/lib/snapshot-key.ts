/**
 * Snapshot cheap gate — performance roadmap R1 (P0) + R5 (v29 fix round).
 *
 * WIRE KEY (R5 contract, Kabir implements the server side against the
 * same shape): `lastSnapshotKey = { version, serverSeq, maxLastFixAtMs,
 * epochMs }`, sent on `snapshot.request` / `resync.request` alongside
 * `lastServerSeq`. `maxLastFixAtMs` is the DURABLE watermark — the
 * server's field (see `WsSnapshotPayload.maxLastFixAtMs`), null when
 * nobody has reported a fix (null, never 0: 0 would claim a fix at
 * the epoch). `epochMs` is a top-level snapshot field the server sets
 * at load/restore and changes on every DO wake, so a wake that restores
 * an identical-looking snapshot still differs in the key and the client
 * re-fetches instead of trusting a collided `serverSeq`.
 *
 * The client's cheap gate (the string key below) keys on the same four
 * fields, exact format `version:serverSeq:maxLastFixAtMs:epochMs`
 * (nulls render as `null`). Same key = same server state, so the
 * JSON.stringify + whole fan-out is skipped outright.
 *
 * Tolerant reads: both server fields are read off a cast — the shared
 * snapshot type gains them on the server side, and this reader keeps
 * the client working with servers from before them. A snapshot that
 * predates the server watermark falls back to computing it from the
 * players' `lastFixAt` (the same durable value, persisted ≤ 30 s).
 * A snapshot with no players and no field keys on null.
 */
import type { PlayerView, WsSnapshotPayload } from '@pakdam/shared';

/**
 * The R5 wire key: `{ version, serverSeq, maxLastFixAtMs, epochMs }`.
 * `maxLastFixAtMs` is null when no fix exists (never 0); `epochMs` is
 * null when the server predates it.
 */
export interface LastSnapshotKey {
  version: number;
  serverSeq: number;
  maxLastFixAtMs: number | null;
  epochMs: number | null;
}

/** Epoch ms of the freshest `lastFixAt` across the roster, or 0 when none. */
export function maxLastFixAtMs(players: PlayerView[]): number {
  let max = 0;
  for (const p of players) {
    if (!p.lastFixAt) continue;
    const ms = Date.parse(p.lastFixAt);
    if (Number.isFinite(ms) && ms > max) max = ms;
  }
  return max;
}

/**
 * The durable watermark, server field wins. A present number is the
 * server's value; an explicit null means nobody has reported a fix
 * (null, never 0 — do NOT fall back to the computed value, which
 * would also be none); an absent field (old server) falls back to
 * computing it from the players, and no fixes at all reads as null.
 */
export function readSnapshotWatermarkMs(snapshot: WsSnapshotPayload): number | null {
  const raw = (snapshot as unknown as { maxLastFixAtMs?: unknown }).maxLastFixAtMs;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (raw === null) return null;
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  const computed = maxLastFixAtMs(snapshot.players ?? []);
  return computed > 0 ? computed : null;
}

/**
 * The DO-wake epoch, top-level snapshot field. Null when the server
 * predates it (or sends a non-number) — a null epoch simply never
 * discriminates, it never breaks the key.
 */
export function readSnapshotEpochMs(snapshot: WsSnapshotPayload): number | null {
  const raw = (snapshot as unknown as { epochMs?: unknown }).epochMs;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** The R5 wire key for a snapshot: `{ version, serverSeq, maxLastFixAtMs, epochMs }`. */
export function buildLastSnapshotKey(snapshot: WsSnapshotPayload): LastSnapshotKey {
  return {
    version: snapshot.version,
    serverSeq: snapshot.serverSeq,
    maxLastFixAtMs: readSnapshotWatermarkMs(snapshot),
    epochMs: readSnapshotEpochMs(snapshot),
  };
}

/**
 * The cheap-gate key, exact format
 * `version:serverSeq:maxLastFixAtMs:epochMs` (nulls render as `null`).
 */
export function buildSnapshotKey(snapshot: WsSnapshotPayload): string {
  const key = buildLastSnapshotKey(snapshot);
  return `${key.version}:${key.serverSeq}:${key.maxLastFixAtMs ?? 'null'}:${key.epochMs ?? 'null'}`;
}
