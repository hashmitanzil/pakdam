'use client';
import type { CSSProperties, ReactNode } from 'react';
import styles from './host-setup.module.css';

const hintStyle: CSSProperties = { margin: '4px 0 0', fontSize: 14, lineHeight: 1.45, color: '#5B4A4A' };

/** Row layout lives in host-setup.module.css (.stepperRow /
 *  .stepperRowText): the text column has a 180px flex basis and the
 *  row stacks vertically below 480px, so a long stepper value can
 *  never squeeze the label down to a column of single letters
 *  (Defect 1, 2026-11-18 — Zone size measured 11px wide at 360px). */

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ margin: '20px 0' }} aria-label={title}>
      <h2 style={{ fontSize: 13, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#5B4A4A', margin: '0 0 4px' }}>{title}</h2>
      <div className="card" style={{ margin: '8px 0' }}>{children}</div>
    </section>
  );
}

/** − / + stepper over a fixed list of steps (e.g. 15 / 30 / 45 min).
 *  The buttons step through the list; the current value is shown
 *  between them. Disabled at the ends. */
export function StepperRow({ label, hint, steps, value, display, onChange, disabled, ariaLabel }: {
  label: string; hint?: string; steps: readonly number[]; value: number;
  display: string; onChange: (v: number) => void; disabled?: boolean; ariaLabel?: string;
}) {
  const idx = steps.indexOf(value);
  const cur = idx === -1 ? 0 : idx;
  const go = (dir: -1 | 1) => {
    const next = steps[Math.min(steps.length - 1, Math.max(0, cur + dir))];
    if (next !== undefined && next !== value) onChange(next);
  };
  return (
    <div className={styles.stepperRow}>
      <div className={styles.stepperRowText}>
        <strong style={{ display: 'block', fontSize: 16 }}>{label}</strong>
        {hint ? <p style={hintStyle}>{hint}</p> : null}
      </div>
      <div className={styles.stepperControls} role="group" aria-label={ariaLabel ?? label}>
        <button type="button" className="btn btn-secondary" style={{ minWidth: 48, minHeight: 48, padding: '10px 12px' }} onClick={() => go(-1)} disabled={disabled || cur <= 0} aria-label={`Decrease ${label}`}>−</button>
        <output className={styles.stepperOutput} aria-live="polite">{display}</output>
        <button type="button" className="btn btn-secondary" style={{ minWidth: 48, minHeight: 48, padding: '10px 12px' }} onClick={() => go(1)} disabled={disabled || cur >= steps.length - 1} aria-label={`Increase ${label}`}>+</button>
      </div>
    </div>
  );
}

/** A real on/off switch (button with aria-pressed + a visual knob),
 *  not a checkbox styled to look like one. The state is also shown
 *  as a word ("On"/"Off") next to the switch — position and colour
 *  alone are not enough for every player. */
export function ToggleRow({ label, hint, checked, onChange, disabled }: {
  label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <div className={styles.stepperRow}>
      <div className={styles.stepperRowText}>
        <strong style={{ display: 'block', fontSize: 16 }}>{label}</strong>
        {hint ? <p style={hintStyle}>{hint}</p> : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span className="toggle-state" aria-hidden="true">{checked ? 'On' : 'Off'}</span>
        <button
          type="button" role="switch" aria-checked={checked} aria-label={label}
          disabled={disabled} onClick={() => onChange(!checked)}
        style={{
          flexShrink: 0, width: 64, height: 48, borderRadius: 999, border: 0, cursor: disabled ? 'not-allowed' : 'pointer',
          background: checked ? '#B91C1C' : '#C9B8B8', position: 'relative', padding: 0, opacity: disabled ? 0.55 : 1,
        }}
      >
        <span style={{
          position: 'absolute', top: 6, left: checked ? 24 : 4, width: 36, height: 36,
          borderRadius: '50%', background: '#fff', transition: 'left 0.15s ease',
          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }} />
        <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>{checked ? 'On' : 'Off'}</span>
        </button>
      </div>
    </div>
  );
}
