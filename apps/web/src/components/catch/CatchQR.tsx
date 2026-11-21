/**
 * CatchQR — the Runner's QR (show) / the Hunter's scanner (scan)
 * (SCRAM-SPEC §9, v18 founder flow).
 *
 * The QR encodes only the raw one-time catch token. The token is never
 * shown as text and never typed — there is no catch code anywhere in
 * Pakdam. Show mode renders the Runner's QR automatically the moment a
 * claim exists (no "SHOW MY QR" tap). Scan mode runs the Hunter's camera
 * at the top of the catch screen; a decode is reported to the page,
 * which holds the token until the Hunter taps Tag in the column below.
 * When the camera fails, the manual fallback (pick the Runner by name)
 * takes over — no code is ever spoken or typed.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';

export interface CatchQRProps {
  /** 'show' renders the Runner's QR; 'scan' opens the Hunter's camera scanner. */
  mode: 'show' | 'scan';
  /** Raw one-time token for the QR (show mode only). Never rendered as text. */
  token: string | null;
  /** Runner's name, shown under the QR. */
  runnerName: string;
  /** Scanner decoded a QR token. */
  onScan: (rawToken: string) => void;
  /** Camera could not start, or scanning failed. */
  onScanError?: (message: string) => void;
  /** "Runner can't show a QR?" — switches to the manual name picker. */
  onManualFallback: () => void;
}

export function CatchQR({
  mode,
  token,
  runnerName,
  onScan,
  onScanError,
  onManualFallback,
}: CatchQRProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  // (m) The scanner used to run silently forever at ≤640 px, every 3rd
  // frame — a QR held far, small or blurry never decoded and nothing
  // said so. After ~5 s without a decode it escalates to full
  // resolution, every frame, and says so.
  const [notDetecting, setNotDetecting] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // The decode loop NEVER exits on the first decode (P1-28): a wrong scan
  // must let the Hunter re-scan in place, not force Cancel → "Scan their
  // QR" again. The loop keeps running until a valid scan or Cancel; the
  // same QR value is ignored for 3 s so one frame is not reported twice,
  // and "Scan again" clears the lock immediately.
  const lastScannedRef = useRef<{ value: string; atMs: number } | null>(null);
  const [, setScanNonce] = useState(0);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const onScanErrorRef = useRef(onScanError);
  onScanErrorRef.current = onScanError;

  // SHOW — render the token as a QR image, nothing else. The page
  // renders this automatically once a claim exists — no extra tap.
  useEffect(() => {
    if (mode !== 'show' || !token) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(token, { width: 220, margin: 1 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, token]);

  // SCAN — camera + jsQR frame decoding. The page holds the decoded
  // token until the Hunter taps Tag below the camera.
  // B19: full-resolution frames every animation frame were the most
  // expensive per-frame work on the catch screen. Frames start
  // downscaled to ~640 px wide and decoded only every 3rd frame — jsQR
  // still reads a 220 px QR comfortably at that size, at a third of
  // the cost. (m) After ~5 s without a decode, the loop escalates to
  // full resolution every frame until a read succeeds — a far, small
  // or blurry QR gets a real second chance instead of failing silently.
  useEffect(() => {
    if (mode !== 'scan') return;
    let raf = 0;
    let stopped = false;
    let frame = 0;
    let startedAtMs = 0;
    let decoded = false;
    let hintShown = false;
    lastScannedRef.current = null;
    setNotDetecting(false);

    const decodeLoop = () => {
      if (stopped) return;
      frame += 1;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && video.readyState === video.HAVE_ENOUGH_DATA) {
        if (startedAtMs === 0) startedAtMs = Date.now();
        // Escalated once no decode has landed in ~5 s: full resolution,
        // every frame, until a read succeeds.
        const escalated = !decoded && Date.now() - startedAtMs > 5_000;
        if (escalated && !hintShown) {
          hintShown = true;
          setNotDetecting(true);
        }
        if ((escalated || frame % 3 === 0) && canvas) {
          const scale = escalated ? 1 : Math.min(1, 640 / video.videoWidth);
          const width = Math.max(1, Math.round(video.videoWidth * scale));
          const height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(video, 0, 0, width, height);
            const imageData = ctx.getImageData(0, 0, width, height);
            const result = jsQR(imageData.data, width, height);
            if (result?.data) {
              decoded = true;
              const value = result.data.trim();
              const last = lastScannedRef.current;
              // Same QR within 3 s = the same frame re-read: ignore it.
              // A different QR, or the same one after a wrong scan cooled
              // off, is reported — the loop keeps running either way.
              if (!last || last.value !== value || Date.now() - last.atMs > 3000) {
                lastScannedRef.current = { value, atMs: Date.now() };
                onScanRef.current(value);
              }
            }
          }
        }
      }
      raf = window.requestAnimationFrame(decodeLoop);
    };

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((stream) => {
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          void video.play().catch(() => undefined);
        }
        raf = window.requestAnimationFrame(decodeLoop);
      })
      .catch(() => {
        setCameraError('Camera unavailable — use the manual fallback below.');
        onScanErrorRef.current?.('Camera unavailable.');
      });

    return () => {
      stopped = true;
      window.cancelAnimationFrame(raf);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [mode]);

  if (mode === 'show') {
    if (!token || !qrDataUrl) {
      return (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#26262B] bg-[#141416] p-6 text-center">
          <p className="text-[15px] font-bold text-white">{runnerName}</p>
          <p className="text-[14px] text-[#A1A1AA]">
            QR unavailable — the Hunter can claim you by name instead.
          </p>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#26262B] bg-[#141416] p-6 text-center">
        {/* Plain <img> on purpose: the QR is a generated data URL, which next/image does not optimise. */}
        <img src={qrDataUrl} alt={`QR code for ${runnerName}`} width={220} height={220} className="rounded-xl bg-white p-2" />
        <p className="text-[18px] font-bold text-white">{runnerName}</p>
        <p className="text-[13px] text-[#A1A1AA]">Show this to the Hunter who tagged you.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative overflow-hidden rounded-2xl border border-[#26262B] bg-black">
        <video
          ref={videoRef}
          playsInline
          muted
          className="aspect-[3/4] w-full object-cover"
          aria-label="QR scanner camera"
        />
        <canvas ref={canvasRef} className="hidden" aria-hidden />
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 h-48 w-48 -translate-x-1/2 -translate-y-1/2 rounded-2xl border-2 border-[#EF4444]"
        />
      </div>
      <p className="text-center text-[14px] text-[#A1A1AA]">Point at the runner&apos;s QR</p>
      {notDetecting ? (
        <p className="text-center text-[14px] text-[#F59E0B]">
          Not detecting a QR — move closer, hold steady, and make sure the whole QR is inside the frame.
        </p>
      ) : null}
      {cameraError ? (
        <p className="text-center text-[14px] text-[#EF4444]">{cameraError}</p>
      ) : null}
      {/* After a wrong scan ("That QR didn't match") the camera keeps
          running — tap Scan again to re-read at once instead of
          cancelling out and reopening the scanner. */}
      <button
        type="button"
        onClick={() => {
          lastScannedRef.current = null;
          setScanNonce((n) => n + 1);
        }}
        className="self-center text-[15px] font-semibold text-white"
      >
        Scan again
      </button>
      <button
        type="button"
        onClick={onManualFallback}
        className="self-center text-[15px] font-semibold text-[#EF4444]"
      >
        Runner can&apos;t show a QR?
      </button>
    </div>
  );
}
