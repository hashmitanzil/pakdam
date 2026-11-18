/**
 * Report / block — local demo store (this device only).
 *
 * A report is a record a player files about another player (or a board
 * entry): display name, reason, optional detail, room code, time. In
 * this demo it is stored on this device and written to the room event
 * log so the host sees it; production sends it to the moderation queue
 * and, for a formal complaint, to the grievance flow (Rule 20).
 *
 * A block is local only: it hides that player from your friends /
 * "Played with" suggestions on this device and marks them "Blocked by
 * you" in the lobby. It does not remove them from anyone else's game
 * and it does not tell them. Only the host removing a player pre-start
 * takes someone out of a game.
 *
 * Nothing here stores a location, a phone number, or any contact
 * detail — display names only.
 */
export type ReportReason =
  | 'Unsafe behaviour'
  | 'Cheating / fake location'
  | 'Harassment'
  | 'Offensive name or message'
  | 'Other';

export const REPORT_REASONS: ReportReason[] = [
  'Unsafe behaviour',
  'Cheating / fake location',
  'Harassment',
  'Offensive name or message',
  'Other',
];

export interface PlayerReport {
  id: string;
  at: string;
  reporterName: string | null;
  subjectName: string;
  roomCode: string | null;
  reason: ReportReason;
  detail: string;
}

const REPORTS_KEY = 'pakdam.reports.v1';
const BLOCKED_KEY = 'pakdam.blocked.v1';

export function loadReports(): PlayerReport[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem(REPORTS_KEY) ?? '[]') as PlayerReport[];
    return Array.isArray(raw) ? raw.filter((r) => typeof r?.subjectName === 'string') : [];
  } catch {
    return [];
  }
}

export function fileReport(report: Omit<PlayerReport, 'id' | 'at'>): PlayerReport {
  const record: PlayerReport = {
    ...report,
    id: `rep-${Date.now().toString(36)}-${Math.floor(Math.random() * 10000)}`,
    at: new Date().toISOString(),
  };
  try {
    const all = loadReports();
    all.push(record);
    localStorage.setItem(REPORTS_KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: the report still counts as filed for this visit
    // (the caller writes it to the room log); it just won't persist.
  }
  return record;
}

function norm(name: string): string {
  return name.trim().toLowerCase();
}

export function loadBlockedNames(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem(BLOCKED_KEY) ?? '[]') as string[];
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function isBlocked(displayName: string): boolean {
  return loadBlockedNames().some((n) => norm(n) === norm(displayName));
}

export function blockPlayer(displayName: string): string[] {
  const next = Array.from(new Set([...loadBlockedNames(), displayName.trim()]));
  try {
    localStorage.setItem(BLOCKED_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: keep the in-memory list for this visit.
  }
  return next;
}

export function unblockPlayer(displayName: string): string[] {
  const next = loadBlockedNames().filter((n) => norm(n) !== norm(displayName));
  try {
    localStorage.setItem(BLOCKED_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: keep the in-memory list for this visit.
  }
  return next;
}
