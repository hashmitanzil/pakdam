/**
 * CatchQR — SHOW MY QR / CATCH BY QR (SCRAM-SPEC §9).
 *
 * The QR encodes only the raw one-time catch token. The token is never
 * shown as text and never typed — there is no catch code anywhere in
 * Pakdam. The scanner decodes camera frames with jsQR; when the camera
 * fails, the manual fallback (pick the Runner by name) takes over — no
 * code is ever spoken or typed.
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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scannedRef = useRef(false);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const onScanErrorRef = useRef(onScanError);
  onScanErrorRef.current = onScanError;

  // SHOW MY QR — render the token as a QR image, nothing else.
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

  // CATCH BY QR — camera + jsQR frame decoding.
  useEffect(() => {
    if (mode !== 'scan') return;
    let raf = 0;
    let stopped = false;
    scannedRef.current = false;

    const decodeLoop = () => {
      if (stopped) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        const width = video.videoWidth;
        const height = video.videoHeight;
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, width, height);
          const imageData = ctx.getImageData(0, 0, width, height);
          const result = jsQR(imageData.data, width, height);
          if (result?.data && !scannedRef.current) {
            scannedRef.current = true;
            onScanRef.current(result.data.trim());
            return;
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
      {cameraError ? (
        <p className="text-center text-[14px] text-[#EF4444]">{cameraError}</p>
      ) : null}
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
