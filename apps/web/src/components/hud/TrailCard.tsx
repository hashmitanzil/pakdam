'use client';
import { useState } from 'react';
import styles from './hud.module.css';

/**
 * Trail card (Worker 3, 2026-11-17) — the shareable round recap card.
 * Local only: the text is copied to the clipboard on this device and
 * nothing is sent to a server. It contains moments and counts only —
 * no positions, no routes, no coordinates — because location data is
 * deleted at match end. The caller builds the text from real match
 * data; nothing here invents a stat.
 */
export default function TrailCard({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
    window.setTimeout(() => setCopied(false), 3000);
  };
  return (
    <section className={styles.trailCard} aria-label="Shareable round card">
      <h2 style={{ margin: '0 0 8px', color: '#fff' }}>Round card — share it</h2>
      <pre>{text}</pre>
      <button type="button" className="btn" onClick={copy}>
        {copied ? '✓ Copied to clipboard' : 'Copy round card'}
      </button>
      <p style={{ margin: '8px 0 0', opacity: 0.85, fontSize: 13 }}>
        Saved on this device only — nothing is uploaded. The card has no locations or routes: location data
        is deleted at match end.
      </p>
    </section>
  );
}
