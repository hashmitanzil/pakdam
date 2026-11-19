'use client';

/**
 * iOS-style toggle — SCRAM-SPEC §11.
 * Red ON (#EF4444), grey OFF (#3F3F46), 52×32 px.
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
      className={`relative h-8 w-[52px] shrink-0 rounded-full transition-colors ${
        checked ? 'bg-[#EF4444]' : 'bg-[#3F3F46]'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span
        className={`absolute top-[3px] h-[26px] w-[26px] rounded-full bg-white shadow transition-all ${
          checked ? 'left-[23px]' : 'left-[3px]'
        }`}
      />
    </button>
  );
}
