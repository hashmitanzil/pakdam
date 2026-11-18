'use client';
import { useMemo, useState } from 'react';
import type { DemoRoom } from '@/lib/demo-store';
import type { CatchView, PlayerView, Room } from '@pakdam/shared';
import { buildRoundCardText, buildRoundCardTextFromLive, summarizeRound, summarizeRoundFromLive } from './round-card';
import styles from './profile.module.css';

/** Input for a LIVE round card, from GET /v1/rooms/:id/results
 *  (spec'd in docs/API.md, HNT-030 — NOT yet implemented in the
 *  Worker). Pass exactly the route's { room, players, catches }.
 *  Do NOT build this from get-state: it has no catches and hides
 *  other seats' roles, so the card would silently show 0 catches. */
export interface LiveRoundInput {
  room: Room;
  players: PlayerView[];
  catches: CatchView[];
}

/**
 * Shareable round card — the polished visual version of the text recap.
 *
 * Clean layout: outcome banner, three count tiles (caught / still free /
 * confirmed catches), the moments that matter (most tags, never caught,
 * clean sweep), and one primary action — copy the recap text. The text
 * is Pakdam's own words (see round-card.ts); the player pastes it
 * wherever their group already chats. Pakdam posts nothing anywhere.
 *
 * Local only: the card is built from the game stored on this device.
 * No positions, no routes, no locations — location data is deleted at
 * match end. Only finished games get a card.
 *
 * LIVE: pass `live` instead of `room` once GET /v1/rooms/:id/results
 * exists — the card renders identically from the live shapes. Until
 * then every caller passes `room` (demo store) and the card is
 * device-local; never mix the two — pass exactly one of them.
 */
export default function ShareRoundCard({ room, live }: { room?: DemoRoom; live?: LiveRoundInput }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const summary = useMemo(
    () => (live ? summarizeRoundFromLive(live.room, live.players, live.catches) : room ? summarizeRound(room) : null),
    [room, live],
  );
  const text = useMemo(
    () => (live ? buildRoundCardTextFromLive(live.room, live.players, live.catches) : room ? buildRoundCardText(room) : ''),
    [room, live],
  );
  const roomCode = live?.room.roomCode ?? room?.room.roomCode ?? '';
  const isLive = Boolean(live);

  if (!summary) return null;

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
    <div className={styles.shareCard} aria-label={`Round card for room ${roomCode}`}>
      <div className={styles.shareBanner}>
        <strong>{summary.outcomeLabel}</strong>
        <span>
          Room {roomCode} · {summary.modeLabel} · {summary.playerCount} players · {summary.durationLabel}
        </span>
      </div>

      <div className={styles.shareTiles}>
        <div className={styles.shareTile}>
          <div className={styles.shareTileValue}>{summary.caughtCount}</div>
          <div className={styles.shareTileLabel}>{summary.caughtWord}</div>
        </div>
        <div className={styles.shareTile}>
          <div className={styles.shareTileValue}>{summary.survivorNames.length}</div>
          <div className={styles.shareTileLabel}>Still free</div>
        </div>
        <div className={styles.shareTile}>
          <div className={styles.shareTileValue}>{summary.confirmedCount}</div>
          <div className={styles.shareTileLabel}>Confirmed catches</div>
        </div>
      </div>

      <ul className={styles.shareMoments}>
        <li>
          <strong>Most tags:</strong>{' '}
          {summary.topHunter
            ? `${summary.topHunter.displayName} — ${summary.topHunter.tags} confirmed tag${summary.topHunter.tags === 1 ? '' : 's'}`
            : 'No confirmed catches in this game.'}
        </li>
        <li>
          <strong>Never caught:</strong>{' '}
          {summary.neverCaughtNames.length > 0
            ? summary.neverCaughtNames.join(', ')
            : 'Nobody — every Runner was caught.'}
        </li>
        <li>
          <strong>Clean sweep:</strong>{' '}
          {summary.cleanSweep ? 'Yes — every Runner was caught.' : 'No — at least one Runner survived.'}
        </li>
        {summary.ejectedNames.length > 0 ? (
          <li>
            <strong>Ejected:</strong> {summary.ejectedNames.join(', ')} — out of play, never counted as caught.
          </li>
        ) : null}
        {summary.disputedCount > 0 ? (
          <li>
            <strong>Disputed catches:</strong> {summary.disputedCount} — awaiting host review.
          </li>
        ) : null}
      </ul>

      <p className="small" style={{ margin: '8px 0' }}>
        Moments and counts only — no locations, no routes. This card is built from{' '}
        {isLive ? 'the finished game on the server.' : 'the game stored on this device.'}
      </p>
      <p style={{ margin: '8px 0 0' }}>
        <button type="button" className="btn" onClick={copy}>
          {copied ? '✓ Copied — paste it anywhere' : 'Copy round card text'}
        </button>
      </p>
      {copied ? (
        <p role="status" className="small">
          Copied. Paste it into your group chat — Pakdam does not post it anywhere itself.
        </p>
      ) : null}
      {failed ? (
        <p role="status" className="small">
          Copy didn’t work in this browser — the text is below; long-press it to select and copy by hand.
        </p>
      ) : null}
      {failed ? (
        <pre className={styles.shareText}>{text}</pre>
      ) : null}
    </div>
  );
}
