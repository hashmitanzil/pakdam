/**
 * Offline queue — PROTOCOL-MAP §2.1 (R12).
 *
 * Commands sent while disconnected are DISCARDED, never queued. This queue
 * holds ONLY non-competitive actions — bug-report drafts, settings — never
 * location, catches, pings or votes. Queued items replay on reconnect on a
 * best-effort basis.
 */
export type OfflineQueueKind = 'bug-report' | 'settings' | 'grievance';

export interface OfflineQueueItem {
  id: string;
  kind: OfflineQueueKind;
  roomId: string | null;
  /** Plain JSON payload — never a location, catch, ping or vote. */
  payload: Record<string, unknown>;
  queuedAtMs: number;
  attempts: number;
}

const STORAGE_KEY = 'pakdam.offline-queue.v1';
const MAX_ITEMS = 50;
const MAX_ATTEMPTS = 3;

function readQueue(): OfflineQueueItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OfflineQueueItem[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(items: OfflineQueueItem[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
  } catch {
    // Storage unavailable — the queue is best-effort.
  }
}

/** Enqueue a non-competitive action. Competitive actions must never be enqueued. */
export function enqueueOfflineAction(
  kind: OfflineQueueKind,
  roomId: string | null,
  payload: Record<string, unknown>,
): OfflineQueueItem {
  const item: OfflineQueueItem = {
    id: crypto.randomUUID(),
    kind,
    roomId,
    payload,
    queuedAtMs: Date.now(),
    attempts: 0,
  };
  const queue = readQueue();
  queue.push(item);
  writeQueue(queue);
  return item;
}

/** All queued items, oldest first. */
export function readOfflineQueue(): OfflineQueueItem[] {
  return readQueue();
}

/** Remove one item (after a successful replay, or after giving up). */
export function removeOfflineAction(id: string): void {
  writeQueue(readQueue().filter((item) => item.id !== id));
}

/**
 * Replay queued items on reconnect. `send` is called once per item; it
 * returns true when the server accepted the item. Items that fail 3 times
 * are dropped. Best-effort only.
 */
export async function replayOfflineQueue(
  send: (item: OfflineQueueItem) => Promise<boolean>,
): Promise<{ sent: number; dropped: number }> {
  let sent = 0;
  let dropped = 0;
  for (const item of readQueue()) {
    let ok = false;
    try {
      ok = await send(item);
    } catch {
      ok = false;
    }
    if (ok) {
      removeOfflineAction(item.id);
      sent += 1;
    } else if (item.attempts + 1 >= MAX_ATTEMPTS) {
      removeOfflineAction(item.id);
      dropped += 1;
    } else {
      const queue = readQueue().map((queued) =>
        queued.id === item.id ? { ...queued, attempts: queued.attempts + 1 } : queued,
      );
      writeQueue(queue);
    }
  }
  return { sent, dropped };
}
