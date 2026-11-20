'use client';

/**
 * Capsule switch — SCRAM style (founder-corrected, supersedes the 54×30
 * v11 toggle).
 *
 * The track is a CAPSULE / pill, ~48 × 24 px, fully rounded — the SCRAM
 * toggle from the video frames, shorter than the 30 px v11 version. The
 * white circular knob is ~22 px diameter (nearly the track height, ~1 px
 * margin top/bottom) and slides end to end on a smooth 200 ms transition.
 * Knob offsets: OFF left-[1px], ON left-[25px] (48 − 22 − 1 = 25).
 * The pill alone carries the state (colour + knob position) — no
 * separate On/Off word beside it, which made the row read cluttered.
 * Red track when ON (#EF4444), dark grey when OFF (#3F3F46). The knob
 * is a true circle, centred vertically, with a soft shadow so it reads
 * as a physical switch.
 */
export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, disabled = false }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[24px] w-[48px] shrink-0 rounded-full transition-colors duration-200 ${
        checked ? 'bg-[#EF4444]' : 'bg-[#3F3F46]'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span
        className={`absolute top-1/2 h-[22px] w-[22px] -translate-y-1/2 rounded-full bg-white shadow-md transition-all duration-200 ease-in-out ${
          checked ? 'left-[25px]' : 'left-[1px]'
        }`}
      />
    </button>
  );
}
