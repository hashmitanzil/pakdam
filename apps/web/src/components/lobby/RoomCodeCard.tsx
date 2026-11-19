'use client';

/**
 * RoomCodeCard — the game-code card (SCRAM-SPEC §5b, task brief).
 *
 * Huge monospace code + COPY pill (becomes `COPIED ✓` for 3 s), SHARE
 * CODE + SETTINGS row, Change code (host, live rooms), and the demo
 * invite link. Copy covers sharing; the invite link is the URL form of
 * the same code (`/join/<CODE>`).
 */
import { useEffect, useState } from 'react';

export interface RoomCodeCardProps {
  code: string;
  isHost: boolean;
  /** Live rooms can regenerate; demo rooms cannot (local-only code). */
  canChangeCode: boolean;
  onOpenSettings: () => void;
  onChangeCode: () => void;
  /** One-line answers (e.g. demo code-change) surface in the lobby notice. */
  onNotice?: (message: string) => void;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
      return true;
    } catch {
      return false;
    }
  }
}

export function RoomCodeCard({
  code,
  isHost,
  canChangeCode,
  onOpenSettings,
  onChangeCode,
  onNotice,
}: RoomCodeCardProps) {
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [inviteLink, setInviteLink] = useState('');
  useEffect(() => {
    setInviteLink(`${window.location.origin}/join/${code}`);
  }, [code]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 3000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyCode = async (): Promise<void> => {
    if (await copyText(code)) setCopied(true);
  };

  const shareCode = async (): Promise<void> => {
    const shareData = {
      title: 'Pakdam',
      text: `Join my Pakdam game with code ${code}`,
      url: inviteLink,
    };
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        // Share dismissed — fall through to copying the link.
      }
    }
    if (await copyText(inviteLink)) {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 3000);
    }
  };

  return (
    <section
      aria-label="Game code"
      className="rounded-[16px] border border-[#26262B] bg-[#141416] p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="pakdam-label">Game code</p>
          <p className="pakdam-code mt-2 text-white pakdam-numeric">{code}</p>
          <p className="mt-2 text-[13px] text-[#A1A1AA]">
            Share the code — no account needed to join.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void copyCode()}
          className="shrink-0 rounded-full border border-[#EF4444] px-3 py-1 text-[13px] font-bold uppercase tracking-wide text-[#EF4444]"
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <div className="mt-3 flex items-center gap-4">
        <button
          type="button"
          onClick={() => void shareCode()}
          className="text-[15px] font-semibold text-[#EF4444]"
        >
          {linkCopied ? 'Link copied ✓' : 'Share code'}
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          className="text-[15px] font-semibold text-[#EF4444]"
        >
          Settings
        </button>
        {isHost ? (
          <button
            type="button"
            onClick={() => {
              if (!canChangeCode) {
                onNotice?.('Changing the code needs a live room — this is a demo room.');
                return;
              }
              onChangeCode();
            }}
            className="text-[15px] font-semibold text-[#EF4444]"
          >
            Change code
          </button>
        ) : null}
      </div>
      {inviteLink ? (
        <button
          type="button"
          onClick={() => void copyText(inviteLink).then((ok) => ok && setLinkCopied(true))}
          className="mt-2 block truncate text-[13px] text-[#A1A1AA]"
          aria-label="Copy invite link"
        >
          {linkCopied ? 'Link copied ✓ — ' : ''}
          {inviteLink}
        </button>
      ) : null}
    </section>
  );
}
