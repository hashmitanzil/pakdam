'use client';
import { useState } from 'react';

/** Shareable round card — TEXT ONLY. Builds a short plain-text recap
 *  from the match data the page already holds (outcome, caught /
 *  surviving counts, standout players). No invented stats, no routes,
 *  no locations, no invented sharing service: the player copies the
 *  text and shares it wherever they already chat. Copy uses the
 *  clipboard when available, with a manual-select fallback. */
export default function RoundCard({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };
  return (
    <section className="card" aria-label="Shareable round card">
      <h2>Round card — share as text</h2>
      <p className="small">Copy this recap and paste it wherever your group already chats. It contains no locations and no routes.</p>
      <pre
        style={{
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#FFF7F5',
          border: '1px solid #E8CFCF', borderRadius: 12, padding: 12, font: 'inherit', margin: '8px 0',
        }}
      >
        {text}
      </pre>
      <p>
        <button type="button" className="btn" onClick={copy}>{copied ? '✓ Copied — paste it anywhere' : 'Copy round card text'}</button>
      </p>
      {copied ? <p role="status">Copied. Paste it into your group chat — Pakdam does not post it anywhere itself.</p> : null}
      {failed ? (
        <p role="status">Copy didn’t work in this browser — long-press the text above to select it and copy it by hand.</p>
      ) : null}
    </section>
  );
}
