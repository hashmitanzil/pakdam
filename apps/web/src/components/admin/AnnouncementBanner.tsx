'use client';

/**
 * The announcement banner, exactly as it reads on the game home
 * page. Shared by the home page (public read) and the announcements
 * preview in the console, so the preview can never drift from the
 * real thing. Dismissible — the dismissal is per session.
 */
import type { PublicAdminAnnouncement } from '../../lib/admin/admin-client';

export function AnnouncementBanner({
  announcement,
  onDismiss,
}: {
  announcement: PublicAdminAnnouncement;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      data-announcement-id={announcement.id}
      className="flex items-start justify-between gap-3 rounded-[14px] border border-[#EF4444]/50 bg-[#141416] px-4 py-3"
    >
      <p className="text-[15px] leading-snug text-white">{announcement.message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss announcement"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[10px] bg-[#1E1E22] text-[18px] font-bold text-white"
      >
        ×
      </button>
    </div>
  );
}
