/** Offline queue holds ONLY non-competitive actions (bug report drafts,
 *  settings). Location updates, catches, pings and votes are NEVER queued
 *  — a queued competitive action is discarded on reconnect. */
export interface OfflineQueueItem { queueId: string; command: string; payload: unknown; queuedAt: string }
const KEY = 'pakdam.offline-queue.v1';
export function queueNonCompetitive(command: string, payload: unknown): void {
  const items: OfflineQueueItem[] = JSON.parse(localStorage.getItem(KEY) ?? '[]') as OfflineQueueItem[];
  items.push({ queueId: crypto.randomUUID(), command, payload, queuedAt: new Date().toISOString() });
  localStorage.setItem(KEY, JSON.stringify(items));
}
