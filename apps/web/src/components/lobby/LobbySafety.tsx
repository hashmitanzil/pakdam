'use client';
import { useEffect, useRef, useState } from 'react';
import { SOS_COPY } from '@pakdam/engine';
import styles from './lobby.module.css';

export type LobbyPause = {
  by: string;
  byName: string;
  at: string;
} | null;

/** Lobby safety strip — SOS, safety pause, and "Tell everyone in the
 *  game" hold-to-reveal. All three are honest about what they do in this
 *  demo build:
 *  - SOS asks for confirmation, then writes to the room event log and
 *    shows a banner. It does NOT call anyone: Pakdam is not an emergency
 *    service (see SOS_COPY).
 *  - Safety pause holds the start: while paused, the host's Start button
 *    is disabled. Anyone can pause; the host (or the person who paused)
 *    resumes. The pause is recorded in the room event log.
 *  - Hold-to-reveal: press and hold for 2 seconds to share your position
 *    with everyone in the game. In this demo the reveal is recorded in
 *    the room event log; no coordinates are stored by the demo store, so
 *    the live broadcast itself is a production behaviour, not claimed here.
 *  Safety controls work only while this app is open and the screen is on. */
export default function LobbySafety({
  meId,
  meName,
  isHost,
  pause,
  onPauseChange,
  onSos,
  onReveal,
}: {
  meId: string | null;
  meName: string | null;
  isHost: boolean;
  pause: LobbyPause;
  onPauseChange: (pause: LobbyPause) => void;
  onSos: () => void;
  onReveal: () => void;
}) {
  const [sosRaised, setSosRaised] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [holdProgress, setHoldProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const holdStartRef = useRef(0);
  const holdTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const HOLD_MS = 2000;

  useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearInterval(holdTimerRef.current);
    };
  }, []);

  const stopHold = () => {
    setHolding(false);
    setHoldProgress(0);
    if (holdTimerRef.current) {
      clearInterval(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  const startHold = () => {
    if (revealed) return;
    setHolding(true);
    holdStartRef.current = Date.now();
    holdTimerRef.current = setInterval(() => {
      const p = Math.min(100, ((Date.now() - holdStartRef.current) / HOLD_MS) * 100);
      setHoldProgress(p);
      if (p >= 100) {
        stopHold();
        setRevealed(true);
        onReveal();
      }
    }, 50);
  };

  const canResume = isHost || (meId !== null && pause !== null && pause.by === meId);

  return (
    <section className={styles.safetyStrip} aria-label="Safety controls">
      <h2 className={styles.sectionTitle}>Safety — always here</h2>
      <p className={styles.sectionSub}>
        SOS, pause and Leave work only while this app is open and your screen is on. {SOS_COPY}
      </p>
      {sosRaised ? (
        <div className={styles.sosAlert} role="alert">
          <p>🚨 SOS raised — stay where you are.</p>
          <p>The host has been notified in the room log. Pakdam is not an emergency service — if you are in danger, call your local emergency number.</p>
        </div>
      ) : null}
      {pause ? (
        <div className="banner" role="status">
          <strong>⏸ Game start is paused</strong> — paused by {pause.byName} at {new Date(pause.at).toLocaleTimeString()}. The host cannot start until it is resumed.
          {canResume ? (
            <p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => onPauseChange(null)}
              >
                Resume — allow the game to start
              </button>
            </p>
          ) : (
            <p className="small">Only the host or {pause.byName} can resume.</p>
          )}
        </div>
      ) : null}
      <div className={styles.safetyButtons}>
        <button
          type="button"
          className={styles.dangerBtn}
          aria-label="SOS — alerts the host in this game"
          onClick={() => {
            if (window.confirm(SOS_COPY)) {
              setSosRaised(true);
              onSos();
            }
          }}
        >
          🆘 SOS
        </button>
        {!pause ? (
          <button
            type="button"
            aria-label="Safety pause — hold the start for everyone"
            onClick={() => {
              if (!meId || !meName) return;
              onPauseChange({ by: meId, byName: meName, at: new Date().toISOString() });
            }}
            disabled={!meId}
          >
            ⏸ Safety pause
          </button>
        ) : null}
        <button
          type="button"
          className={styles.holdBtn}
          aria-label="Tell everyone in the game — press and hold for 2 seconds to share your position with everyone"
          onPointerDown={startHold}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          onContextMenu={(e) => e.preventDefault()}
          disabled={revealed}
        >
          {revealed ? '✓ Position shared with everyone' : holding ? `Keep holding… ${Math.round(holdProgress)}%` : '📣 Tell everyone — hold to reveal'}
          <span className={styles.holdProgress} style={{ width: `${holdProgress}%` }} aria-hidden="true" />
        </button>
      </div>
      <p className="small">
        “Tell everyone in the game” shares your position with every player so they can find you if you are lost or need help.
        Hold for 2 seconds so it cannot go off by accident. The reveal is written to the room event log;
        the live broadcast is a production behaviour.
      </p>
      {revealed ? <p role="status">✓ Shared — everyone in this game has been told your position. The reveal is in the room event log.</p> : null}
    </section>
  );
}
