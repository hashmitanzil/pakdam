'use client';
import { formatDistance, hotColdLevel, hotColdTier, pingAgeLabel, type HotColdTier } from './freshness';

/** Compass-radar view (23 §6B): bearing + proximity band to the approximate
 *  ping area — an alternative to the full map while walking. It never shows
 *  more than the map view is allowed to show: a coarse area / tier, never
 *  an exact pin. Bearing/distance are only shown when a ping actually
 *  supplied them; otherwise the honest "no ping yet" state is shown.
 *  Freshness is words, not colour: "Reported 2 min ago" vs "just now". */
export const HOT_COLD_TIERS: HotColdTier[] = ['Searching', 'Getting warmer', 'Warm', 'Hot', 'Burning'];

export function HotColdReadout({ distanceMeters, reportedAt }: { distanceMeters: number | null; reportedAt: string | null }) {
  const { tier, note } = hotColdTier(distanceMeters);
  const level = hotColdLevel(distanceMeters);
  return (
    <div className="card" role="group" aria-label="Hot or cold proximity readout">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Hot / cold</h2>
        <span className="tag" aria-label={`Proximity tier: ${tier}`}>{tier}</span>
      </div>
      <p style={{ margin: '8px 0 4px', fontSize: 20 }}>
        <strong>{tier}</strong>{distanceMeters !== null ? ` — roughly ${formatDistance(distanceMeters)} to the nearest ping area` : ''}
      </p>
      <p className="small" style={{ margin: '0 0 8px' }}>{note}</p>
      <p className="small" style={{ margin: '0 0 8px' }}>
        {reportedAt ? `Ping ${pingAgeLabel(reportedAt).toLowerCase()} — ${new Date(reportedAt).toLocaleTimeString()}.` : 'No ping reported yet.'}
      </p>
      <div role="meter" aria-valuenow={level} aria-valuemin={0} aria-valuemax={4} aria-label={`Heat level ${level} of 4: ${tier}`} style={{ display: 'flex', gap: 4 }}>
        {HOT_COLD_TIERS.map((t, i) => (
          <span
            key={t}
            title={t}
            aria-hidden="true"
            style={{
              flex: 1, height: 14, borderRadius: 999,
              background: i <= level ? (i <= 1 ? '#F59E0B' : i === 2 ? '#EA580C' : '#B91C1C') : '#E8CFCF',
              border: i === level ? '2px solid #1A0E0E' : '2px solid transparent',
            }}
          />
        ))}
      </div>
      <ol className="tier-list" aria-label="Proximity tiers, coldest to hottest">
        {HOT_COLD_TIERS.map((t, i) => (
          <li key={t} aria-current={i === level ? 'true' : undefined} className={i === level ? 'tier-active' : undefined}>
            {i === level ? '▶ ' : ''}{t}
          </li>
        ))}
      </ol>
      <p className="small">Tier thresholds are calibration OPEN — these words are the spec’s tiers, not measured distances. Hunters see Runners only as a coarse ping area, never an exact pin.</p>
    </div>
  );
}

export default function CompassRadar({
  distanceMeters, bearingDegrees, bearingWordLabel, reportedAt, areaLabel,
}: {
  distanceMeters: number | null;
  bearingDegrees: number | null;
  bearingWordLabel: string;
  reportedAt: string | null;
  areaLabel: string;
}) {
  const { tier } = hotColdTier(distanceMeters);
  const rotation = bearingDegrees === null ? 0 : ((bearingDegrees % 360) + 360) % 360;
  return (
    <div className="card radar" role="region" aria-label={`Compass radar — ${tier}, ${areaLabel}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Compass radar</h2>
        <span className="tag">{tier}</span>
      </div>
      {distanceMeters === null ? (
        <p>No ping yet — the radar has nothing to point at. The next scheduled ping will give a coarse area.</p>
      ) : (
        <>
          <div className="radar-dial" aria-hidden="true">
            <span style={{ position: 'absolute', top: 6, left: '50%', transform: 'translateX(-50%)', fontWeight: 800, fontSize: 12 }}>N</span>
            <span className="radar-needle" style={{ transform: `rotate(${rotation}deg)` }}>▲</span>
            <span className="radar-centre">You</span>
          </div>
          <p style={{ fontSize: 18, margin: '8px 0 4px' }}><strong>{tier}</strong> — nearest ping area is roughly {formatDistance(distanceMeters)} away{bearingWordLabel ? `, ${bearingWordLabel}` : ''}.</p>
          <p className="small" style={{ margin: 0 }}>{areaLabel} · {pingAgeLabel(reportedAt)} · This is a coarse area, not a precise location.</p>
        </>
      )}
      <p className="small">Radar view only — switch back to the map any time. It never shows more than the map is allowed to show.</p>
    </div>
  );
}
