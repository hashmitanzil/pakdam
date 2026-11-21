'use client';

/**
 * PakdamWordmark — the PAKDAM header logo, cropped from the founder
 * lockup image (pakdam-logo-lockup.webp → public/brand-wordmark.webp,
 * lockup y956-1211, 1424x255). Bold red serif, swoosh removed
 * (2026-11-21): the swoosh underline starts 1 px below the letters'
 * baseline (strict red from y1212, its AA feather reaching y1211),
 * so the crop ends flush at the baseline — no bottom margin is
 * possible with a rectangular crop, and the single bottom row y1211
 * (P-stem flat bottom + M-foot edge) is shaved, invisible at display
 * size. The exact wordmark art, not a font approximation. The
 * crop's near-black background blends with the app's #0A0A0B surfaces.
 *
 * If the image fails to load, the broken-image glyph is never shown:
 * the img hides itself and plain "Pakdam" text takes its place.
 *
 * Used wherever the wordmark is a header/logo (home header). It is
 * NOT used on the role-reveal flash (play page) — that screen is a
 * solid red/green background and the red wordmark would be unreadable
 * there — nor for body headings, which stay in the Oswald display face.
 */
import { useState } from 'react';

export function PakdamWordmark({ height = 26 }: { height?: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        className="font-bold tracking-wide text-[#EF4444]"
        style={{ fontSize: `${height}px`, lineHeight: 1 }}
      >
        Pakdam
      </span>
    );
  }
  return (
    <img
      src="/brand-wordmark.webp"
      alt="Pakdam"
      height={height}
      width={Math.round(height * (1424 / 255))}
      style={{ height: `${height}px`, width: 'auto', maxWidth: '100%' }}
      onError={() => setFailed(true)}
    />
  );
}
