'use client';
import { useState } from 'react';
import HoldToReveal from './HoldToReveal';
import styles from './hud.module.css';

export type PlayView = 'map' | 'radar' | 'radio';

/**
 * Bottom tabs (Worker 3, 2026-11-17) — SCRAM-style Map / Radio / … .
 * One thumb-reachable row: Map, Radar (compass + hot/cold, the walking
 * view), Radio. "…" opens the More sheet: safety (pause, SOS, I'm safe),
 * hold-to-reveal, and Leave. There is no theme toggle any more
 * (2026-11-18, simplification): Pakdam has one dark theme.
 */
export default function BottomTabs({
  view,
  onView,
  paused,
  onPause,
  onSos,
  onSafe,
  onLeave,
  onReveal,
  revealDone,
}: {
  view: PlayView;
  onView: (v: PlayView) => void;
  paused: boolean;
  onPause: () => void;
  onSos: () => void;
  onSafe: () => void;
  onLeave: () => void;
  onReveal: () => void;
  revealDone: boolean;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const tabs: { id: PlayView; label: string; icon: string }[] = [
    { id: 'map', label: 'Map', icon: '🗺' },
    { id: 'radar', label: 'Radar', icon: '🧭' },
    { id: 'radio', label: 'Radio', icon: '📻' },
  ];
  return (
    <div>
      <div className={styles.tabs} role="tablist" aria-label="Match view">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={view === t.id}
            onClick={() => {
              setMoreOpen(false);
              onView(t.id);
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
        <button type="button" aria-expanded={moreOpen} aria-label="More options — safety, leave" onClick={() => setMoreOpen((o) => !o)}>
          ⋯ More
        </button>
      </div>
      {moreOpen ? (
        <div className={styles.moreSheet} role="region" aria-label="More options">
          <h2>More — safety</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary" style={{ flex: 1, minHeight: 52 }} onClick={onPause}>
              {paused ? '▶ Resume game' : '❚❚ Safety pause'}
            </button>
            <button type="button" className="btn btn-danger" style={{ flex: 1, minHeight: 52 }} onClick={onSos}>
              SOS
            </button>
            <button type="button" className="btn btn-secondary" style={{ flex: 1, minHeight: 52 }} onClick={onSafe}>
              ✓ I&apos;m safe
            </button>
          </div>
          <HoldToReveal onReveal={onReveal} done={revealDone} />
          <p className="small" style={{ margin: 0 }}>
            Safety pause, SOS, “I&apos;m safe” and Leave work only while this app is open and your screen is
            on. SOS shares your position with the host and pauses the match — Pakdam is NOT an emergency
            service. If you are in danger, call your local emergency number.
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ minHeight: 52 }}
            onClick={() => {
              if (window.confirm('Leave the game? This stops sharing your location.')) onLeave();
            }}
          >
            Leave game — stop sharing my location
          </button>
        </div>
      ) : null}
    </div>
  );
}
