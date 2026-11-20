'use client';

/**
 * Pill switch — ShadowHunt / iOS style.
 *
 * The pill alone carries the state (colour + knob position) — no
 * separate On/Off word beside it, which made the row read cluttered.
 * A clearly elongated capsule track (60 × 30 px, a 2:1 ratio so it
 * reads as a capsule, never a near-circle) with a white circular knob
 * (26 px, unchanged) that slides end to end on a smooth 200 ms
 * transition. Red track when ON (#EF4444), dark grey when OFF
 * (#3F3F46). The knob is a true circle, centred vertically, with a
 * soft shadow so it reads as a physical switch — never a square or
 * a half-pill.
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
      className={`relative h-[30px] w-[60px] shrink-0 rounded-full transition-colors duration-200 ${
        checked ? 'bg-[#EF4444]' : 'bg-[#3F3F46]'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span
        className={`absolute top-1/2 h-[26px] w-[26px] -translate-y-1/2 rounded-full bg-white shadow-md transition-all duration-200 ease-in-out ${
          checked ? 'left-[32px]' : 'left-[2px]'
        }`}
      />
    </button>
  );
}
