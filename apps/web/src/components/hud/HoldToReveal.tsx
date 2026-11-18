'use client';
import { useRef, useState } from 'react';
import styles from './hud.module.css';

const HOLD_MS = 2000;

/**
 * "Tell everyone in the game" — hold-to-reveal (Worker 3, 2026-11-17).
 * Press and hold for 2 seconds; a progress fill shows the hold, and the
 * reveal fires only on a full hold, so a pocket tap cannot share your
 * coarse 150 m area by accident. The reveal itself is the caller's job
 * (demo: a host check-in event in the room log); this component only
 * reports that a full hold happened. Labelled honestly: it shares a
 * coarse 150 m area with everyone in the game — never an exact pin —
 * and it works only while the app is open.
 */
export default function HoldToReveal({ onReveal, done }: { onReveal: () => void; done: boolean }) {
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const startRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const stop = (fired: boolean) => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    startRef.current = null;
    setHolding(false);
    if (!fired) setProgress(0);
  };

  const tick = () => {
    if (startRef.current === null) return;
    const elapsed = Date.now() - startRef.current;
    const p = Math.min(1, elapsed / HOLD_MS);
    setProgress(p);
    if (p >= 1) {
      stop(true);
      onReveal();
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  };

  const start = () => {
    if (done) return;
    startRef.current = Date.now();
    setHolding(true);
    rafRef.current = requestAnimationFrame(tick);
  };

  return (
    <div>
      <button
        type="button"
        className={`${styles.holdButton} ${done ? styles.holdDone : ''}`}
        disabled={done}
        aria-label="Tell everyone in the game — press and hold for 2 seconds to share a coarse 150 m area with everyone in the game"
        onPointerDown={start}
        onPointerUp={() => stop(false)}
        onPointerLeave={() => stop(false)}
        onPointerCancel={() => stop(false)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span className={styles.holdProgress} style={{ width: `${Math.round(progress * 100)}%` }} aria-hidden="true" />
        <span>
          {done
            ? '✓ Position shared with everyone in the game'
            : holding
              ? `Keep holding… ${Math.round(progress * 100)}%`
              : 'Hold to tell everyone in the game'}
        </span>
      </button>
      <p className="small" style={{ margin: '4px 0 0' }}>
        Hold for 2 seconds to share a coarse 150 m area with everyone in the game. Works only while the app
        is open. Use it if you are lost, hurt, or need everyone to find you.
      </p>
    </div>
  );
}
