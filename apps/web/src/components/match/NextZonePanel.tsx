'use client';
import { useEffect, useState } from 'react';
import type { ZoneConfig } from '@pakdam/shared';
import { bearingBetween, bearingWord, formatClock, formatDistance, haversineMeters, nextShrinkPhase, pointInPolygon, polygonCentroid, zoneSizeLabel } from './freshness';

/** Next-zone preview + way-back guide (23 §6A, 24 S05).
 *  Uses zone.shrinkPhases when present; otherwise says plainly that no
 *  shrink is scheduled for this room — never invents coordinates or times.
 *  PREVIEW, NOT THE FINAL ZONE: the stored shrink-phase boundaries are
 *  size placeholders only (see host-setup/draft.ts) — the server draws
 *  the real, randomly offset boundary per shrink, at the moment the
 *  shrink fires. So this panel and the dashed line on the map show the
 *  PLANNED SIZE of the next zone, and say so in plain words; the exact
 *  final position is decided by the server and may differ. The zone ring
 *  is informational: it is not an enforced physical boundary and the UI
 *  never claims the server can force a player back. */
export default function NextZonePanel({
  zone, startedAt, fix,
}: {
  zone: ZoneConfig;
  startedAt: string | null;
  fix: { lat: number; lng: number } | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const next = nextShrinkPhase(zone, startedAt, now);
  const centre = polygonCentroid(zone.boundary);
  const inside = fix && zone.boundary.length >= 3 ? pointInPolygon(fix.lat, fix.lng, zone.boundary) : null;
  const distToCentre = fix && centre ? Math.round(haversineMeters(fix.lat, fix.lng, centre.lat, centre.lng)) : null;
  const bearing = fix && centre ? bearingWord(bearingBetween(fix.lat, fix.lng, centre.lat, centre.lng)) : '';
  const nextSize = next ? zoneSizeLabel(next.boundary) : null;
  // Progress through the current shrink interval, for the countdown bar.
  // Interval start = previous phase time (or match start), end = next phase.
  const elapsed = startedAt ? Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000)) : null;
  const prevAt = next ? (zone.shrinkPhases[next.phaseIndex - 1]?.atSeconds ?? 0) : null;
  const intervalPct = next && next.inSeconds !== null && elapsed !== null && prevAt !== null && next.atSeconds > prevAt
    ? Math.min(100, Math.max(0, Math.round(((elapsed - prevAt) / (next.atSeconds - prevAt)) * 100)))
    : null;

  return (
    <section className="card zone-panel" aria-label="Next zone preview and way back guide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Next zone — preview</h2>
        <span className="tag">Zone now: {zoneSizeLabel(zone.boundary)}</span>
      </div>
      {next && next.inSeconds !== null ? (
        <>
          <p style={{ margin: '8px 0 4px' }}>
            <strong>Shrinks in {formatClock(next.inSeconds)}</strong>
            {nextSize ? ` — next zone ${nextSize.toLowerCase()}` : ''} · shrink {next.phaseIndex + 1} of {next.totalPhases}. Preview only — the dashed line on the map shows the planned size, not the final zone: the server draws the real zone when the shrink fires, so the exact position may differ.
          </p>
          {intervalPct !== null ? (
            <div role="progressbar" aria-valuenow={intervalPct} aria-valuemin={0} aria-valuemax={100} aria-label={`Time until next zone shrink: ${formatClock(next.inSeconds)}`} style={{ height: 10, borderRadius: 999, background: '#E8CFCF', overflow: 'hidden' }}>
              <div style={{ width: `${intervalPct}%`, height: '100%', background: '#B91C1C' }} />
            </div>
          ) : null}
        </>
      ) : next && elapsed === null ? (
        <p><strong>Next zone shrink scheduled</strong> — the countdown starts when the match starts. Preview only — the dashed line on the map shows the planned size, not the final zone: the server draws the real zone when the shrink fires.</p>
      ) : (
        <p><strong>No zone shrink scheduled for this room.</strong> This room’s zone is fixed for the whole match (shrink phases: none configured). The boundary on the map is the play area.</p>
      )}
      <h3 style={{ margin: '12px 0 4px' }}>Way back</h3>
      {fix === null ? (
        <p style={{ margin: 0 }}>No live location yet — the way-back guide needs a live fix. Keep the app open and your screen on.</p>
      ) : inside === true ? (
        <p style={{ margin: 0 }}>✓ You are inside the play zone{distToCentre !== null ? ` — about ${formatDistance(distToCentre)} from the zone centre` : ''}.</p>
      ) : inside === false ? (
        <p style={{ margin: 0 }}><strong>You are outside the play zone.</strong>{distToCentre !== null ? ` About ${formatDistance(distToCentre)} ${bearing ? `that way (${bearing})` : 'from the zone centre'}.` : ''} Head back towards the boundary — a 30-second countdown is running, and at 0 you are ejected from the game.</p>
      ) : (
        <p style={{ margin: 0 }}>Zone shape not available — the way-back guide cannot be computed for this room.</p>
      )}
      <p className="small" style={{ margin: '8px 0 0' }}>The zone is a plan, not a punishment. It does not force you back — it shows you where the play area is.</p>
    </section>
  );
}
