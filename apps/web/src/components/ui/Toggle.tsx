'use client';

/**
 * Pill switch — ShadowHunt / iOS style.
 *
 * A proper pill: a rounded track (52 × 32 px) with a white circular knob
 * that slides end to end on a smooth 200 ms transition. Red track when
 * ON (#EF4444), dark grey when OFF (#3F3F46). The knob is a true circle,
 * centred vertically, with a soft shadow so it reads as a physical
 * switch — never a square or a half-pill. The On/Off word sits beside
 * the switch as a text label only; the pill itself carries the state.
 */
export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, disabled = false }: ToggleProps) {
  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      <span
        className={`text-[13px] font-bold ${checked ? 'text-white' : 'text-[#A1A1AA]'}`}
        aria-hidden
      >
        {checked ? 'On' : 'Off'}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative h-8 w-[52px] shrink-0 rounded-full transition-colors duration-200 ${
          checked ? 'bg-[#EF4444]' : 'bg-[#3F3F46]'
        } ${disabled ? 'opacity-50' : ''}`}
      >
        <span
          className={`absolute top-1/2 h-[26px] w-[26px] -translate-y-1/2 rounded-full bg-white shadow-md transition-all duration-200 ease-in-out ${
            checked ? 'left-[23px]' : 'left-[3px]'
          }`}
        />
      </button>
    </span>
  );
}
