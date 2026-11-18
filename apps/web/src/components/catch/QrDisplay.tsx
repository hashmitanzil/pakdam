'use client';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import styles from './catch.module.css';

/** Runner shows a short-lived, match-bound QR. The Hunter scans it to
 *  complete the tag. There is NO code in Pakdam — the one-time token
 *  lives ONLY inside this QR (no location, no player ID, no room
 *  coordinates), and it is never shown as text and never typed.
 *  Showing the QR is NOT a catch — the tag already happened in person;
 *  the scan only proves it, and the claim completes when the Hunter
 *  scans (or the Runner confirms manually if the camera is
 *  unavailable). The QR appears only after the Runner taps "Got tagged"
 *  on their own screen — it is never shown before that tap, and never
 *  on the Hunter's screen.
 *
 *  Redesign 2026-11-17: QR only, live countdown to expiry, no code
 *  text, no copy button. `expiresAt` must be the claim's real expiry
 *  (requestedAt + token TTL) — the countdown only counts down when the
 *  parent passes a fixed instant, not Date.now() + TTL. */
export default function QrDisplay({ token, expiresAt }: { token: string; expiresAt: string }) {
  const [src, setSrc] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(() => Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)));

  useEffect(() => { void QRCode.toDataURL(token, { width: 220 }).then(setSrc).catch(() => setSrc('')); }, [token]);
  useEffect(() => {
    const id = setInterval(() => setSecondsLeft(Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000))), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const expired = secondsLeft <= 0;

  return (
    <div className={`card ${styles.qrCard}`}>
      <h2 className={styles.qrTitle}>Show this to the Hunter</h2>
      <p className={styles.qrSub}>The Hunter scans it to complete the tag. Showing it is <strong>not</strong> a catch — the tag already happened in person; the scan only proves it.</p>
      {src ? (
        <div className={styles.qrFrame}>
          <img src={src} alt="Catch QR code — show to the Hunter" width={220} height={220} />
        </div>
      ) : (
        <p>QR unavailable — ask the Hunter to request a new one.</p>
      )}
      <p className={`${styles.qrExpiry} ${expired ? styles.qrExpiryExpired : ''}`} role="timer">
        {expired ? '✕ This QR has expired — ask the Hunter to request a new one.' : `One-time QR · expires in ${secondsLeft} s`}
      </p>
      <p className="small">Only the Hunter standing with you should see this QR. Never share a screenshot of it in a chat — a scan alone never proves a catch, but it starts one.</p>
    </div>
  );
}
