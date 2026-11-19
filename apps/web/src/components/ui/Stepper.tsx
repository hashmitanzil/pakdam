'use client';

/**
 * Stepper (− / +) — ShadowHunt style (founder): only + and −, no slider.
 * Value bold white 17 px centred; − / + are dark #1E1E22 squares with white
 * glyphs, 40 px, radius 10 px, inside a 48 px hit area.
 */
export interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  /** Step size. Defaults to 1. Ignored when `steps` is set. */
  step?: number;
  /**
   * Discrete grid of allowed values (ascending). When set, − / + move to
   * the adjacent grid value instead of adding `step` — so a value can
   * never sit off-grid or snap back to where it started (the old
   * "Shrinks every" bug: step 1 + nearest-grid snapping pinned 10 min).
   */
  steps?: readonly number[];
  min?: number;
  max?: number;
  label: string;
  format?: (value: number) => string;
  disabled?: boolean;
}

/** Index of the grid entry nearest `value` (first entry wins ties). */
function nearestGridIndex(steps: readonly number[], value: number): number {
  let best = 0;
  let bestDist = Math.abs((steps[0] ?? value) - value);
  steps.forEach((entry, i) => {
    const dist = Math.abs(entry - value);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}

export function Stepper({  value,
  onChange,
  step = 1,
  steps,
  min,
  max,
  label,
  format,
  disabled = false,
}: StepperProps) {
  // Grid mode: index of the current value in the grid (nearest entry if
  // the value is somehow off-grid); plain mode falls back to step math.
  const gridIndex = steps ? nearestGridIndex(steps, value) : -1;
  const nextDown = steps ? steps[gridIndex - 1] : value - step;
  const nextUp = steps ? steps[gridIndex + 1] : value + step;
  const canDecrease =
    !disabled &&
    nextDown !== undefined &&
    (min === undefined || nextDown >= min) &&
    (steps === undefined || gridIndex > 0);
  const canIncrease =
    !disabled &&
    nextUp !== undefined &&
    (max === undefined || nextUp <= max) &&
    (steps === undefined || gridIndex < steps.length - 1);

  return (
    <div
      className="flex items-center justify-between"
      role="group"
      aria-label={label}
    >
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={!canDecrease}
        onClick={() => {
          if (nextDown !== undefined) onChange(nextDown);
        }}
        className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#1E1E22] text-[20px] font-bold text-white disabled:opacity-40"
      >
        −
      </button>
      <span
        className="min-w-16 text-center text-[17px] font-bold text-white pakdam-numeric"
        aria-live="polite"
      >
        {format ? format(value) : value}
      </span>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={!canIncrease}
        onClick={() => {
          if (nextUp !== undefined) onChange(nextUp);
        }}
        className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#1E1E22] text-[20px] font-bold text-white disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
}
