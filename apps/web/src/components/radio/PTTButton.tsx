/**
 * PTTButton — the floating push-to-talk mic (SCRAM-SPEC §8c–d).
 *
 * Hold to talk, ≤ 10 s per burst (`VOICE_MAX_BURST_MS` in the lib — the
 * radio stops the burst itself; this button only shows the elapsed time).
 * The mic track is disabled except while held. Renders nothing when there
 * is no live voice radio (demo mode has no signalling channel, so there is
 * no one to talk to — text radio still works there).
 */
'use client';

import type { PointerEvent as ReactPointerEvent } from 'react';
import type { VoiceRadio, PttState } from '@/lib/voice-radio';
import { formatAgeLabel } from '@pakdam/shared';

export interface PTTButtonProps {
  /** Live voice radio, or null in demo mode (renders nothing). */
  radio: VoiceRadio | null;
  pttState: PttState;
  /** Seconds into the current burst. */
  burstSeconds: number;
  size?: 'large' | 'small';
  disabled?: boolean;
}

export function PTTButton({
  radio,
  pttState,
  burstSeconds,
  size = 'large',
  disabled = false,
}: PTTButtonProps) {
  if (!radio) return null;
  const talking = pttState === 'talking';
  const dims = size === 'large' ? 'h-16 w-16 text-[26px]' : 'h-12 w-12 text-[20px]';

  const start = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (disabled) return;
    radio.startTalking();
  };
  const stop = () => {
    radio.stopTalking();
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        aria-label={talking ? 'Release to stop talking' : 'Hold to talk'}
        aria-pressed={talking}
        disabled={disabled}
        onPointerDown={start}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onKeyDown={(event) => {
          if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
            event.preventDefault();
            radio.startTalking();
          }
        }}
        onKeyUp={(event) => {
          if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
            stop();
          }
        }}
        className={`${dims} flex touch-none select-none items-center justify-center rounded-full text-white shadow-lg transition-colors ${
          talking ? 'bg-[#DC2626] scale-95' : 'bg-[#EF4444]'
        } ${disabled ? 'opacity-40' : ''}`}
      >
        <span aria-hidden>{talking ? '●' : '◉'}</span>
      </button>
      {talking ? (
        <span className="pakdam-numeric rounded-full bg-black/70 px-2 py-0.5 text-[12px] font-semibold text-white">
          {formatAgeLabel(burstSeconds)} · let go to send
        </span>
      ) : null}
    </div>
  );
}
