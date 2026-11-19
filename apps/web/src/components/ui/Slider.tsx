'use client';

import { useCallback } from 'react';

/**
 * Slider — SCRAM-SPEC §11.
 * Full-width, red fill to the thumb, grey track, white thumb with red ring,
 * 44 px touch target. Dragging or tapping the track snaps to the nearest
 * step in `steps` (discrete values); the value label updates live.
 */
export interface SliderProps {
  /** Discrete allowed values, in order (e.g. [10, 15, 20, 30, 45, 60]). */
  steps: readonly number[];
  value: number;
  onChange: (value: number) => void;
  label: string;
  format?: (value: number) => string;
  disabled?: boolean;
}

export function Slider({
  steps,
  value,
  onChange,
  label,
  format,
  disabled = false,
}: SliderProps) {
  const index = Math.max(0, steps.indexOf(value));
  const min = steps[0] ?? 0;
  const max = steps[steps.length - 1] ?? 0;

  const onInput = useCallback(
    (nextIndex: number) => {
      const next = steps[nextIndex];
      if (next !== undefined) onChange(next);
    },
    [onChange, steps],
  );

  // Fill percentage for the red track fill.
  const fillPct =
    steps.length > 1 ? (index / (steps.length - 1)) * 100 : 0;

  return (
    <div>
      <div className="relative flex h-11 items-center">
        <div className="absolute inset-x-0 h-[6px] rounded-full bg-[#1E1E22]" />
        <div
          className="absolute left-0 h-[6px] rounded-full bg-[#EF4444]"
          style={{ width: `${fillPct}%` }}
        />
        <input
          type="range"
          className="pakdam-slider relative w-full"
          aria-label={label}
          aria-valuetext={format ? format(value) : String(value)}
          min={0}
          max={steps.length - 1}
          step={1}
          value={index}
          disabled={disabled}
          onChange={(event) => onInput(Number(event.target.value))}
        />
      </div>
      <div className="flex justify-between text-[13px] text-[#A1A1AA] pakdam-numeric">
        <span>{format ? format(min) : min}</span>
        <span className="text-[15px] font-bold text-white">
          {format ? format(value) : value}
        </span>
        <span>{format ? format(max) : max}</span>
      </div>
    </div>
  );
}
