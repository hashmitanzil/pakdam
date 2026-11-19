'use client';

/**
 * ZoneEditor — full-screen zone editor (SCRAM-SPEC §6).
 *
 * Header: Cancel / Play zone / Done. Cancel discards every edit; Done
 * applies the edited zone — the caller writes it to the room config, so
 * the lobby summary updates to the new values (SCRAM's own video shows
 * editor edits not changing the lobby summary; that bug is not reproduced
 * here). Shape toggle Circle | Draw; radius + Final-size (Auto/fixed)
 * steppers; tap-to-place numbered corners; Undo / Start again (on the
 * map); minimal no-go form. Shrink controls live on the lobby only.
 */
import { useEffect, useState } from 'react';
import type { GeoPoint, GeoPolygon, ZoneShape } from '@pakdam/shared';
import { circlePolygon } from '@pakdam/engine';
import { Stepper } from '../ui/Stepper';
import { PlayAreaMap, type ZoneDraft } from './PlayAreaMap';
import {
  autoFinalRadiusMeters,
  boundaryCentre,
  boundaryRadiusMeters,
  drawPointsToBoundary,
  drawSizeRangeLabel,
  finalSizePercent,
  isCompleteDrawPolygon,
} from './drawPoints';
import { formatDistance } from '../../lib/utils';

export interface ZoneEditorResult {
  shape: ZoneShape;
  centre: GeoPoint;
  radiusMeters: number;
  drawPoints: GeoPoint[];
  /** Null = Auto final size. */
  finalRadiusMeters: number | null;
  noGoAreas: GeoPolygon[];
}

export interface ZoneEditorProps {
  open: boolean;
  centre: GeoPoint;
  radiusMeters: number;
  shape: ZoneShape;
  drawPoints: GeoPoint[];
  /** Null = Auto final size. */
  finalRadiusMeters: number | null;
  noGoAreas: GeoPolygon[];
  onCancel: () => void;
  onDone: (result: ZoneEditorResult) => void;
}

const NO_GO_RADIUS_M = 50;

export function ZoneEditor({
  open,
  centre: initialCentre,
  radiusMeters: initialRadius,
  shape: initialShape,
  drawPoints: initialPoints,
  finalRadiusMeters: initialFinal,
  noGoAreas: initialNoGo,
  onCancel,
  onDone,
}: ZoneEditorProps) {
  const [shape, setShape] = useState<ZoneShape>(initialShape);
  const [centre, setCentre] = useState<GeoPoint>(initialCentre);
  const [radius, setRadius] = useState<number>(initialRadius);
  const [points, setPoints] = useState<GeoPoint[]>(initialPoints);
  const [finalMode, setFinalMode] = useState<'auto' | 'fixed'>(
    initialFinal === null ? 'auto' : 'fixed',
  );
  const [finalRadius, setFinalRadius] = useState<number>(
    initialFinal ?? autoFinalRadiusMeters(initialRadius),
  );
  const [noGoAreas, setNoGoAreas] = useState<GeoPolygon[]>(initialNoGo);
  const [placingNoGo, setPlacingNoGo] = useState(false);
  const [placingCorner, setPlacingCorner] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Reset the draft every time the editor opens (Cancel discards edits).
  useEffect(() => {
    if (!open) return;
    setShape(initialShape);
    setCentre(initialCentre);
    setRadius(initialRadius);
    setPoints(initialPoints);
    setFinalMode(initialFinal === null ? 'auto' : 'fixed');
    setFinalRadius(initialFinal ?? autoFinalRadiusMeters(initialRadius));
    setNoGoAreas(initialNoGo);
    setPlacingNoGo(false);
    setPlacingCorner(false);
    setNotice(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  // Arrow keys move the centre, + / − resize (the keyboard line below).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      const stepDeg = 10 / 111_320;
      if (event.key === 'ArrowUp') {
        setCentre((c) => ({ ...c, lat: c.lat + stepDeg }));
        event.preventDefault();
      } else if (event.key === 'ArrowDown') {
        setCentre((c) => ({ ...c, lat: c.lat - stepDeg }));
        event.preventDefault();
      } else if (event.key === 'ArrowLeft') {
        setCentre((c) => ({ ...c, lng: c.lng - stepDeg }));
        event.preventDefault();
      } else if (event.key === 'ArrowRight') {
        setCentre((c) => ({ ...c, lng: c.lng + stepDeg }));
        event.preventDefault();
      } else if (event.key === '+' || event.key === '=') {
        setRadius((r) => r + 50);
      } else if (event.key === '-') {
        setRadius((r) => Math.max(100, r - 50));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open ]);

  if (!open) return null;

  const onZoneChange = (draft: ZoneDraft): void => {
    setCentre(draft.centre);
    setRadius(draft.radiusMeters);
    setShape(draft.shape);
    setPoints(draft.drawPoints);
    if (draft.shape === 'draw' && draft.drawPoints.length > 0) {
      setRadius(boundaryRadiusMeters(drawPointsToBoundary(draft.drawPoints)));
    }
    setPlacingCorner(false);
  };

  const switchShape = (next: ZoneShape): void => {
    if (next === shape) return;
    if (next === 'draw') {
      // Keep the same centre/size: sample the circle as corners.
      setPoints(circlePolygon(centre, radius, 6));
      setShape('draw');
    } else {
      const boundary = drawPointsToBoundary(points);
      if (boundary.length >= 3) {
        setCentre(boundaryCentre(boundary));
        setRadius(boundaryRadiusMeters(boundary));
      }
      setPoints([]);
      setShape('circle');
    }
  };

  const done = (): void => {
    if (shape === 'draw' && !isCompleteDrawPolygon(points)) {
      setNotice('Place at least 3 corners to make a zone.');
      return;
    }
    onDone({
      shape,
      centre,
      radiusMeters: radius,
      drawPoints: shape === 'draw' ? points : [],
      finalRadiusMeters: finalMode === 'auto' ? null : finalRadius,
      noGoAreas,
    });
  };

  const autoFinal = autoFinalRadiusMeters(radius);
  const finalPercent = finalSizePercent(radius, finalMode === 'auto' ? null : finalRadius);

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-[#0A0A0B]"
      role="dialog"
      aria-modal="true"
      aria-label="Play zone"
    >
      <div className="flex items-center justify-between px-4 pt-3">
        <button
          type="button"
          onClick={onCancel}
          className="text-[15px] font-semibold text-[#EF4444]"
        >
          Cancel
        </button>
        <h2 className="text-[18px] font-bold text-white">Play zone</h2>
        <button
          type="button"
          onClick={done}
          className="text-[15px] font-semibold text-[#EF4444]"
        >
          Done
        </button>
      </div>

      <div className="min-h-0 flex-1 px-4 pt-3">
        <PlayAreaMap
          centre={centre}
          radiusMeters={radius}
          shape={shape}
          drawPoints={points}
          finalRadiusMeters={finalMode === 'auto' ? null : finalRadius}
          noGoAreas={noGoAreas}
          editable
          placingNoGo={placingNoGo}
          onZoneChange={onZoneChange}
          onNoGoAdd={(point) => {
            setNoGoAreas((areas) => [...areas, circlePolygon(point, NO_GO_RADIUS_M, 16)]);
            setPlacingNoGo(false);
          }}
          height={320}
        />
      </div>

      <div className="max-h-[46dvh] overflow-y-auto px-4 pb-4 pt-2">
        <div
          className="grid grid-cols-2 gap-1 rounded-[14px] bg-[#1E1E22] p-1"
          role="group"
          aria-label="Zone shape"
        >
          {(['circle', 'draw'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={shape === option}
              onClick={() => switchShape(option)}
              className={`h-11 rounded-[10px] text-[15px] font-bold capitalize ${
                shape === option ? 'bg-[#EF4444] text-white' : 'text-[#A1A1AA]'
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        {shape === 'circle' ? (
          <div className="mt-4">
            <p className="pakdam-label">Zone size</p>
            <Stepper
              label="Zone size"
              value={radius}
              step={50}
              min={100}
              onChange={(v) => setRadius(Math.max(100, v))}
              format={(v) => formatDistance(v)}
            />
            <p className="text-[13px] text-[#A1A1AA]">{formatDistance(radius * 2)} across</p>
            <p className="mt-2 text-[13px] text-[#A1A1AA]">
              Drag the map to move the zone. Runners have to stay inside it.
            </p>
          </div>
        ) : (
          <div className="mt-4">
            <p className="pakdam-label">Corners</p>
            <Stepper
              label="Corners"
              value={points.length}
              step={1}
              min={0}
              max={12}
              onChange={(next) => {
                if (next > points.length) {
                  setPlacingCorner(true);
                  setNotice('Tap the map to place a corner.');
                } else if (next < points.length) {
                  setPoints((p) => p.slice(0, -1));
                }
              }}
              format={(v) => String(v)}
            />
            <p className="text-[13px] text-[#A1A1AA]">
              {points.length > 0 ? drawSizeRangeLabel(points) : 'Tap the map to place corners.'}
              {placingCorner ? ' Tap the map to place a corner.' : ''}
            </p>
            <p className="mt-2 text-[13px] text-[#A1A1AA]">
              Drag a corner to move it, or the middle to move the whole zone.
            </p>
          </div>
        )}

        <div className="mt-4">
          <p className="pakdam-label">Final size</p>
          <button
            type="button"
            onClick={() => setFinalMode((m) => (m === 'auto' ? 'fixed' : 'auto'))}
            className="text-[15px] font-semibold text-[#EF4444]"
          >
            {finalMode === 'auto' ? 'Auto' : 'Fixed — tap for Auto'}
          </button>
          <Stepper
            label="Final size"
            value={finalMode === 'auto' ? autoFinal : finalRadius}
            step={25}
            min={25}
            disabled={finalMode === 'auto'}
            onChange={(v) => setFinalRadius(Math.max(25, v))}
            format={(v) => formatDistance(v)}
          />
          <p className="text-[13px] text-[#A1A1AA]">
            {finalMode === 'auto'
              ? `Auto · ${formatDistance(autoFinal)}`
              : `${formatDistance(finalRadius)} (${finalPercent ?? 0}% of start)`}
          </p>
        </div>

        <div className="mt-4">
          <p className="pakdam-label">No-go areas</p>
          <p className="text-[13px] text-[#A1A1AA]">
            Tap the map to drop a no-go circle. Players must stay out.
          </p>
          <button
            type="button"
            onClick={() => setPlacingNoGo((v) => !v)}
            className="mt-1 text-[15px] font-semibold text-[#EF4444]"
          >
            {placingNoGo ? 'Done placing' : 'Drop a no-go circle'}
          </button>
          {noGoAreas.map((_, index) => (
            <div key={index} className="mt-1 flex items-center justify-between">
              <span className="text-[15px] text-white">No-go {index + 1}</span>
              <button
                type="button"
                onClick={() => setNoGoAreas((areas) => areas.filter((__, i) => i !== index))}
                className="text-[15px] font-semibold text-[#EF4444]"
              >
                Remove
              </button>
            </div>
          ))}
          <p className="mt-2 text-[13px] text-[#A1A1AA]">
            Dark red hatched areas: no-go — players must stay out.
          </p>
        </div>

        {notice ? <p className="mt-3 text-[13px] text-[#F59E0B]">{notice}</p> : null}
        <p className="mt-3 text-[13px] text-[#A1A1AA]">
          Tap the map to move the centre. Arrow keys move it, + / − resize.
        </p>
      </div>
    </div>
  );
}
