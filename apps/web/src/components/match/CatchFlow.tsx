'use client';

/** Catch flow, shown as a stepper so the claim state is visible at a
 *  glance. The EXACT founder sequence (2026-11-17):
 *  Step 1 — Claim: the Hunter tags the Runner IN PERSON, then requests
 *  the catch. The tag starts in person — no tech yet.
 *  Step 2 — Show QR: the Runner taps "Got tagged" and their QR opens
 *  on their own screen.
 *  Step 3 — Scan: the Hunter scans that QR — the scan completes the
 *  claim (hunterId + runnerId + time recorded). Fallback when the
 *  camera is unavailable: the Runner confirms themself manually in a
 *  dialogue box — no code, no QR needed. A scan alone is never a catch
 *  without the Runner's "Got tagged" tap; a disputed catch goes to the
 *  host. No auto-confirm on timeout. */
const STEPS = [
  { n: 1, title: 'Claim', text: 'Hunter tags in person, then requests the catch.' },
  { n: 2, title: 'Show QR', text: 'Runner taps “Got tagged” — their QR opens on their screen.' },
  { n: 3, title: 'Scan', text: 'Hunter scans the QR to complete the tag — or the Runner confirms manually if the camera is unavailable.' },
] as const;

export default function CatchFlow({ step, stateLabel }: { step: 0 | 1 | 2 | 3; stateLabel: string }) {
  return (
    <div className="card" role="group" aria-label={`Catch progress — ${stateLabel}`}>
      <ol className="steps" style={{ flexWrap: 'wrap' }}>
        {STEPS.map((s) => {
          const done = step > s.n;
          const current = step === s.n || (step === 0 && s.n === 1);
          return (
            <li key={s.n} aria-current={current && !done ? 'step' : undefined} style={done ? { borderColor: '#166534', background: '#F0FDF4' } : undefined}>
              {done ? '✓ ' : ''}Step {s.n}: {s.title}
            </li>
          );
        })}
        <li style={step === 3 ? { borderColor: '#166534', background: '#F0FDF4' } : undefined}>
          {step === 3 ? '✓ Done' : 'Done'}
        </li>
      </ol>
      <p style={{ margin: '8px 0 0' }}>
        <strong>{stateLabel}</strong>
      </p>
      <p className="small" style={{ margin: '4px 0 0' }}>
        {step === 0 && 'No claim yet — the Hunter starts Step 1 after the in-person tag.'}
        {step === 1 && STEPS[0]!.text}
        {step === 2 && STEPS[1]!.text}
        {step === 3 && STEPS[2]!.text}
      </p>
      <p className="small" style={{ margin: '4px 0 0' }}>
        No grabbing, blocking, tackling or forced phone handling. GPS proximity is supporting evidence only — it never proves a catch.
      </p>
    </div>
  );
}
