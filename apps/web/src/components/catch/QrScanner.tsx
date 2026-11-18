'use client';
import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import styles from './catch.module.css';

/** Hunter QR scanner — phone camera + jsQR, no server round-trip.
 *  The Runner shows their one-time catch QR (after tapping "Got
 *  tagged"); the Hunter scans it and the decoded token is verified
 *  against the open claim — the scan COMPLETES the claim. The tag
 *  itself already happened in person; the scan only proves it.
 *  The QR contains ONLY the one-time token — no location, no player
 *  ID, no room coordinates — and scanning never shares the Hunter's
 *  location with anyone. Frames are decoded on-device and discarded;
 *  nothing is uploaded or stored.
 *
 *  Camera unavailable (denied, no camera, not HTTPS) is NOT an error
 *  state: the scanner says so plainly and the Runner confirms
 *  themself manually on their own phone instead — that manual confirm
 *  is the fallback, not a code. There is no code in Pakdam. */
export default function QrScanner({
  onScanned,
  onClose,
}: {
  /** Called once with the decoded token text. The caller verifies it. */
  onScanned: (code: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef(0);
  const scannedRef = useRef(false);
  const onScannedRef = useRef(onScanned);
  onScannedRef.current = onScanned;
  const [state, setState] = useState<'starting' | 'scanning' | 'denied' | 'unsupported' | 'error'>('starting');
  const [errorDetail, setErrorDetail] = useState('');

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setState('unsupported');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        if (cancelled) return;
        setState('scanning');
        const tick = () => {
          if (cancelled || scannedRef.current) return;
          const v = videoRef.current;
          const canvas = canvasRef.current;
          if (v && canvas && v.readyState === v.HAVE_ENOUGH_DATA && v.videoWidth > 0) {
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            canvas.width = v.videoWidth;
            canvas.height = v.videoHeight;
            if (ctx) {
              ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
              const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const found = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
              if (found?.data) {
                scannedRef.current = true;
                onScannedRef.current(found.data.trim().toUpperCase());
                return;
              }
            }
          }
          rafRef.current = window.requestAnimationFrame(tick);
        };
        rafRef.current = window.requestAnimationFrame(tick);
      } catch (err) {
        if (cancelled) return;
        const name = err instanceof Error ? err.name : '';
        if (name === 'NotAllowedError') setState('denied');
        else { setState('error'); setErrorDetail(err instanceof Error ? err.message : 'Camera could not be opened.'); }
      }
    })();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  return (
    <div className={`card ${styles.qrCard}`} role="dialog" aria-label="Scan the Runner's QR code">
      <h2 className={styles.qrTitle}>Scan the Runner’s QR</h2>
      {state === 'starting' ? <p role="status">Opening your camera…</p> : null}
      {state === 'scanning' ? (
        <>
          <p className={styles.qrSub}>Point your camera at the Runner’s QR code. The scan only reads the one-time QR token — it never shares your location.</p>
          <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', background: '#000' }}>
            <video ref={videoRef} playsInline muted style={{ display: 'block', width: '100%', height: 'auto' }} aria-label="Camera view — point it at the Runner's QR code" />
            <div aria-hidden="true" style={{ position: 'absolute', inset: '12%', border: '3px solid #fff', borderRadius: 12, boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)', pointerEvents: 'none' }} />
          </div>
          <canvas ref={canvasRef} style={{ display: 'none' }} aria-hidden="true" />
          <p className="small">Scanning… hold still for a second. The scan is verified on this device — nothing is uploaded.</p>
        </>
      ) : null}
      {state === 'denied' ? (
        <p role="alert"><strong>Camera is blocked.</strong> Allow camera access for this site in your browser settings, then try again — or the Runner confirms manually on their own phone instead. That manual confirm is the fallback when the camera cannot scan.</p>
      ) : null}
      {state === 'unsupported' ? (
        <p role="alert"><strong>Camera scanning is not available in this browser.</strong> The Runner confirms manually on their own phone instead — that is the fallback when the camera cannot scan.</p>
      ) : null}
      {state === 'error' ? (
        <p role="alert"><strong>Camera could not be opened.</strong> {errorDetail} The Runner confirms manually on their own phone instead — that is the fallback when the camera cannot scan.</p>
      ) : null}
      <p><button type="button" className="btn btn-secondary" onClick={onClose} style={{ minHeight: 48, width: '100%' }}>Close scanner</button></p>
    </div>
  );
}
