'use client';

/**
 * RoomCodeCard — the game-code card (SCRAM-SPEC §5b, task brief).
 *
 * Huge monospace code + COPY pill (becomes `COPIED ✓` for 3 s), SHARE
 * CODE + SETTINGS row, Change code (host, live rooms), and the demo
 * invite link. Copy covers sharing; the invite link is the URL form of
 * the same code (`/join/<CODE>`).
 */
import { memo, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Sheet } from '@/components/ui/Sheet';

export interface RoomCodeCardProps {
  code: string;
  isHost: boolean;
  /** Live rooms can regenerate; demo rooms cannot (local-only code). */
  canChangeCode: boolean;
  /** A code change is in flight — the button shows it instead of sitting dead. */
  changingCode?: boolean;
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

/** Memoized (B14): the lobby re-renders on every poll tick — the code
 *  card only re-renders when the code, host state or a handler changes. */
export const RoomCodeCard = memo(function RoomCodeCard({
  code,
  isHost,
  canChangeCode,
  changingCode = false,
  onOpenSettings,
  onChangeCode,
  onNotice,
}: RoomCodeCardProps) {
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [inviteLink, setInviteLink] = useState('');
  const [showQr, setShowQr] = useState(false);
  const [inviteQrDataUrl, setInviteQrDataUrl] = useState<string | null>(null);
  const [inviteQrGenerating, setInviteQrGenerating] = useState(false);
  useEffect(() => {
    setInviteLink(`${window.location.origin}/join/${code}`);
  }, [code]);

  // Invite QR — encodes the FULL live invite link (never the bare
  // code), regenerated whenever the link changes (e.g. a code change).
  // Separate from CatchQR: that path encodes raw catch tokens only.
  useEffect(() => {
    if (!showQr || !inviteLink) {
      setInviteQrDataUrl(null);
      setInviteQrGenerating(false);
      return;
    }
    // F10: clear the stale QR as soon as the link changes — a fast
    // scan in the gap must not join with the old code. The sheet shows
    // "Generating QR…" until the new code resolves.
    setInviteQrDataUrl(null);
    setInviteQrGenerating(true);
    let cancelled = false;
    QRCode.toDataURL(inviteLink, { width: 220, margin: 1 })
      .then((url) => {
        if (cancelled) return;
        setInviteQrDataUrl(url);
        setInviteQrGenerating(false);
      })
      .catch(() => {
        if (cancelled) return;
        setInviteQrDataUrl(null);
        setInviteQrGenerating(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showQr, inviteLink]);

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
        <button
          type="button"
          onClick={() => setShowQr(true)}
          className="text-[15px] font-semibold text-[#EF4444]"
        >
          Show QR
        </button>
        {isHost ? (
          <button
            type="button"
            disabled={changingCode}
            onClick={() => {
              if (!canChangeCode) {
                onNotice?.('Changing the code needs a live room — this is a demo room.');
                return;
              }
              onChangeCode();
            }}
            className="text-[15px] font-semibold text-[#EF4444] disabled:opacity-40"
          >
            {changingCode ? 'Changing…' : 'Change code'}
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
      <Sheet open={showQr} onClose={() => setShowQr(false)} title="Join with QR">
        <div className="flex flex-col items-center gap-3 p-2 text-center">
          {inviteQrDataUrl ? (
            // Plain <img> on purpose: the QR is a generated data URL,
            // which next/image does not optimise (same as CatchQR).
            <img
              src={inviteQrDataUrl}
              alt={`QR code to join with code ${code}`}
              width={220}
              height={220}
              className="rounded-xl bg-white p-2"
            />
          ) : inviteQrGenerating ? (
            <p className="text-[14px] text-[#A1A1AA]">Generating QR…</p>
          ) : (
            <p className="text-[14px] text-[#A1A1AA]">
              QR unavailable — share the code instead.
            </p>
          )}
          <p className="text-[18px] font-bold text-white pakdam-numeric">{code}</p>
          <p className="text-[13px] text-[#A1A1AA]">
            Scan to join — no account needed.
          </p>
        </div>
      </Sheet>
    </section>
  );
});
