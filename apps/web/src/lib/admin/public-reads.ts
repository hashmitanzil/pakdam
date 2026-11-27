/**
 * Public game reads — the game home page's startup reads.
 *
 * At startup the game reads, with a short (60 s) cache:
 * - the active announcement (GET /v1/admin/announcements/public)
 * - feature flags (GET /v1/admin/flags/public)
 * - game config (GET /v1/admin/config/public)
 *
 * READ-ONLY wiring: the flags and config are fetched and held here
 * for the game to consult, but this step changes NO game behaviour
 * — the v34 team owns game behaviour. If the admin endpoints are
 * missing or down, the game carries on exactly as before (the reads
 * fail soft; the banner simply does not show).
 */
import type { AdminGameConfig } from '@pakdam/shared';
import {
  getPublicAnnouncement,
  getPublicConfig,
  getPublicFlags,
  type PublicAdminAnnouncement,
  type PublicAdminFlag,
} from './admin-client';

/** Dismissal of the announcement banner, per session. */
export const ANNOUNCEMENT_DISMISSED_KEY = 'pakdam.announcement.dismissed.v1';

/** Flags + config as last read at startup. Null until the first read lands. */
export const publicGameReads: { flags: PublicAdminFlag[] | null; config: AdminGameConfig | null } = {
  flags: null,
  config: null,
};

/**
 * Loads all three public reads at startup. Returns the active
 * announcement (or null). Never throws — a failed read leaves the
 * previous value (or null) in place and the game plays on.
 */
export async function loadPublicGameReads(): Promise<PublicAdminAnnouncement | null> {
  const [announcement, flags, config] = await Promise.all([
    getPublicAnnouncement().catch(() => null),
    getPublicFlags().catch(() => null),
    getPublicConfig().catch(() => null),
  ]);
  if (flags !== null) publicGameReads.flags = flags;
  if (config !== null) publicGameReads.config = config;
  return announcement;
}

export function readDismissedAnnouncementId(): string | null {
  try {
    return window.sessionStorage.getItem(ANNOUNCEMENT_DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function dismissAnnouncement(id: string): void {
  try {
    window.sessionStorage.setItem(ANNOUNCEMENT_DISMISSED_KEY, id);
  } catch {
    // Dismissal lost; the banner shows again next load.
  }
}
