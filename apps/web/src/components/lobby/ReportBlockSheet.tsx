'use client';
import { useState } from 'react';
import { REPORT_REASONS, blockPlayer, isBlocked, type ReportReason } from './report-block';
import styles from './lobby.module.css';

/**
 * Report / block sheet — opened by tapping a player in the lobby (or a
 * row on the leaderboard). The player is never told. Filing a report
 * writes to the room event log so the host sees it; blocking is local
 * only (this device) and never removes the player from the game — only
 * the host removing a player pre-start does that. A formal complaint
 * goes to the grievance page (Rule 20), linked below.
 */
export default function ReportBlockSheet({
  subjectName,
  reporterName,
  roomCode,
  onClose,
  onFiled,
}: {
  subjectName: string;
  reporterName: string | null;
  roomCode: string | null;
  onClose: () => void;
  onFiled: (report: { subjectName: string; reason: ReportReason; detail: string; blocked: boolean }) => void;
}) {
  const [reason, setReason] = useState<ReportReason>('Unsafe behaviour');
  const [detail, setDetail] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(false);
  const [done, setDone] = useState('');
  const alreadyBlocked = isBlocked(subjectName);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (alsoBlock) blockPlayer(subjectName);
    onFiled({ subjectName, reason, detail: detail.trim(), blocked: alsoBlock || alreadyBlocked });
    setDone(
      `Report filed about ${subjectName} (${reason}). The host can see it in the room log. ` +
        (alsoBlock ? 'They are now blocked on this device.' : 'They are not blocked — tick the box below if you want to block them too.'),
    );
  };

  return (
    <div className={styles.sheetOverlay} role="dialog" aria-modal="true" aria-label={`Report or block ${subjectName}`}>
      <div className={styles.sheet}>
        <h2 className={styles.sectionTitle}>Report or block {subjectName}</h2>
        <p className={styles.sectionSub}>
          {subjectName} is not told. A report goes to the host in the room log. Blocking only affects this device —
          it hides them from your friends and “Played with” lists and marks them “Blocked by you” here.
        </p>
        {alreadyBlocked ? <p role="status">✓ {subjectName} is already blocked on this device.</p> : null}
        {done ? (
          <div role="status">
            <p>{done}</p>
            <p>
              <a href="/grievance">File a formal grievance (Rule 20)</a> if this is a complaint about conduct or a
              decision, not just a report in this game.
            </p>
            <p>
              <button type="button" className="btn" onClick={onClose}>
                Done
              </button>
            </p>
          </div>
        ) : (
          <form onSubmit={submit}>
            <label className="label" htmlFor="report-reason">
              What happened?
            </label>
            <select
              id="report-reason"
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value as ReportReason)}
            >
              {REPORT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <label className="label" htmlFor="report-detail">
              What happened, in your words (optional)
            </label>
            <textarea
              id="report-detail"
              className="input"
              rows={3}
              maxLength={500}
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder="A sentence or two — what did they do, and when?"
            />
            <label className={styles.ackBox}>
              <input type="checkbox" checked={alsoBlock} onChange={(e) => setAlsoBlock(e.target.checked)} />
              <span>
                <strong>Also block {subjectName} on this device</strong>
                <br />
                <span className="small">They stay in the game unless the host removes them. Blocking only changes what you see.</span>
              </span>
            </label>
            <p className="small">Filed as {reporterName ?? 'a player in this game'} · Room {roomCode ?? '—'} · No location is attached to a report.</p>
            <div className={styles.sheetActions}>
              <button type="submit" className="btn">
                File report
              </button>
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
