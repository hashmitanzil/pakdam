'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { listRooms, currentPlayerId, type DemoRoom } from '@/lib/demo-store';
import { isLiveTransportEnabled } from '@/lib/websocket';
import { seasonBoard, toScoringRoom, POINTS_RULES } from '@/components/profile/leaderboard';
import type { BoardRow } from '@/components/profile/leaderboard';
import SeasonCountdown from '@/components/leaderboard/SeasonCountdown';
import ReportBlockSheet from '@/components/lobby/ReportBlockSheet';
import { fileReport, type ReportReason } from '@/components/lobby/report-block';
import styles from './leaderboards.module.css';

const OPTIN_KEY = 'pakdam.leaderboard.optin';
const DISPLAY_NAME_KEY = 'pakdam.displayName';
const COUNTRY_KEY = 'pakdam.country';

/**
 * Monthly leaderboard — opt-in ONLY, world + country.
 *
 * What is real here: every point is computed from finished matches on
 * this device (same rules as the profile page: +1 per 3 min free, max
 * 10/round; +10 never caught; +3 per tag; +10 clean sweep). What is
 * PRACTICE: rows for practice players from practice rounds on
 * this device — labelled PRACTICE on every row, never presented as real
 * people, and kept in their own practice section while you are opted
 * out. Real players other than you appear only after they opt in on
 * their own device; in this local build that cannot be verified locally, so
 * they are counted but not shown. Opting out removes you immediately.
 *
 * A board row shows ONLY display name, points, matches and country.
 * Boards never show where or when anyone played. Everything on this
 * page is guest-local: stored on this device only, no account.
 */
export default function BoardClient() {
  const [rooms, setRooms] = useState<DemoRoom[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** LIVE mode is configured (NEXT_PUBLIC_WORKER_URL is set) — but the
   *  Worker has NO leaderboard route (verified in workers/src: the
   *  only read route is GET /v1/rooms/:id, one room, no catches, other
   *  seats' roles hidden — a board cannot be computed from it). So
   *  even in live mode this page stays on the device-local demo board
   *  below, clearly labelled. Never mix demo and live rows. What is
   *  needed: GET /v1/leaderboard (server-computed, opt-in only — no
   *  such route exists, not even in docs/API.md). */
  const [liveConfigured, setLiveConfigured] = useState(false);
  const [optedIn, setOptedIn] = useState(false);
  const [myName, setMyName] = useState('');
  const [myCountry, setMyCountry] = useState('');
  const [tab, setTab] = useState<'world' | 'country'>('world');
  const [reportTarget, setReportTarget] = useState<string | null>(null);
  const [reportDone, setReportDone] = useState('');

  useEffect(() => {
    setRooms(listRooms());
    setLiveConfigured(isLiveTransportEnabled());
    setOptedIn(localStorage.getItem(OPTIN_KEY) === 'yes');
    setMyName(localStorage.getItem(DISPLAY_NAME_KEY) ?? '');
    setMyCountry(localStorage.getItem(COUNTRY_KEY) ?? '');
    setLoaded(true);
  }, []);

  const myId = currentPlayerId();
  const seasonInfo = useMemo(() => {
    const d = new Date();
    return {
      label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
      month: d.getMonth(),
      year: d.getFullYear(),
    };
  }, []);

  const myPlayerIds = useMemo(() => {
    const ids = new Set<string>();
    if (myId) ids.add(myId);
    for (const r of rooms) {
      if (r.players.some((p) => p.playerId === myId)) {
        for (const p of r.players) {
          if (p.playerId === myId) ids.add(p.playerId);
        }
      }
    }
    return ids;
  }, [rooms, myId]);

  const board = useMemo(
    () => seasonBoard(rooms.map(toScoringRoom), seasonInfo.month, seasonInfo.year, myCountry.trim() || null, myPlayerIds),
    [rooms, seasonInfo, myCountry, myPlayerIds],
  );

  // Opt-in gate: your own row shows only if you opted in. Other real
  // players are never shown in this demo (their opt-in lives on their
  // device); demo rows are shown, labelled DEMO.
  const myRows = board.filter((r) => myPlayerIds.has(r.playerId));
  const demoRows = board.filter((r) => r.isDemo && !myPlayerIds.has(r.playerId));
  const hiddenRealCount = board.filter((r) => !r.isDemo && !myPlayerIds.has(r.playerId)).length;
  const shownRows: BoardRow[] = [...(optedIn ? myRows : []), ...demoRows].sort(
    (a, b) => b.total - a.total || b.matchesCounted - a.matchesCounted,
  );
  const countryRows =
    tab === 'country'
      ? shownRows.filter((r) => r.country && r.country.trim().toLowerCase() === myCountry.trim().toLowerCase())
      : shownRows;
  const myRank = optedIn ? shownRows.findIndex((r) => myPlayerIds.has(r.playerId)) + 1 : 0;
  const myPoints = myRows.reduce((s, r) => s + r.total, 0);

  function setOptin(next: boolean) {
    setOptedIn(next);
    localStorage.setItem(OPTIN_KEY, next ? 'yes' : 'no');
  }

  const handleReportFiled = (report: { subjectName: string; reason: ReportReason; detail: string; blocked: boolean }) => {
    fileReport({
      reporterName: myName || null,
      subjectName: report.subjectName,
      roomCode: null,
      reason: report.reason,
      detail: report.detail,
    });
    setReportDone(`Report filed about ${report.subjectName} (${report.reason}).`);
    setReportTarget(null);
  };

  const renderRow = (row: BoardRow, rank: number) => {
    const isMe = myPlayerIds.has(row.playerId);
    return (
      <li key={row.playerId} className={`${styles.boardRow} ${isMe ? styles.boardRowMe : ''}`}>
        <span className={styles.rank} aria-label={`Rank ${rank}`}>
          #{rank}
        </span>
        <span className={styles.boardMain}>
          <strong>
            {row.displayName}
            {isMe ? ' (you)' : ''}
          </strong>
          {row.isDemo ? <span className="tag">PRACTICE</span> : null}
          <br />
          <span className="small">
            {row.matchesCounted} finished {row.matchesCounted === 1 ? 'match' : 'matches'}
            {row.country ? ` · ${row.country}` : ''}
          </span>
        </span>
        <span className={styles.points}>
          <strong>{row.total}</strong> pts
        </span>
        <button
          type="button"
          className={styles.reportBtn}
          onClick={() => setReportTarget(row.displayName)}
          aria-label={`Report ${row.displayName} from the leaderboard`}
        >
          Report
        </button>
      </li>
    );
  };

  return (
    <div>
      <div className={styles.hero}>
        <span className={styles.eyebrow}>Pakdam · Leaderboard</span>
        <h1>Monthly leaderboard</h1>
        <p>
          Season: {seasonInfo.label}. Opt-in only — nobody is listed without choosing to be. Boards show a display
          name, points and country only. Never where anyone played, never when. Stored on this device only — no
          account, no sign-in.
        </p>
        <div className={styles.countdown}>
          <SeasonCountdown seasonLabel={seasonInfo.label} />
        </div>
      </div>

      {!loaded ? (
        <p>Loading…</p>
      ) : (
        <>
          {liveConfigured ? (
            <div className="banner" role="status">
              <strong>Demo board — live leaderboard not available yet.</strong>
              <p>
                Live mode is configured, but the Worker has no leaderboard route, so this board is still
                computed from finished matches on this device only (practice rows labelled PRACTICE). No live
                points are shown here, and no demo points are mixed into any live board.
              </p>
            </div>
          ) : null}
          {!optedIn ? (
            <div className={styles.emptyState} role="status">
              <h2>You are not on the board yet</h2>
              <p>
                Opt-in is off by default, so nobody can see you here — and you can’t see your own points either.
                Joining shows only your display name, your points and your country. Nothing else: never where you
                played, never when. You can leave any time and you come off the board straight away.
              </p>
              <p>
                <button type="button" className="btn btn-lg" onClick={() => setOptin(true)}>
                  Join the leaderboard
                </button>
              </p>
              <p className="small">
                No account needed — this is guest-only for now. A future sign-in will let you keep your points across
                devices; until then your board place lives on this device only. Prefer the full settings?{' '}
                <Link href="/profile">Change this in your profile</Link>.
              </p>
            </div>
          ) : (
            <div className="banner" role="status">
              <strong>
                ✓ You are opted in for {seasonInfo.label}
                {myRank > 0
                  ? ` — you are #${myRank} on the world board with ${myPoints} points.`
                  : ' — no finished matches on this device yet this season, so you have 0 points.'}
              </strong>{' '}
              <Link href="/profile">Change this in your profile</Link> or{' '}
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginLeft: 8 }}
                onClick={() => setOptin(false)}
              >
                Leave the leaderboard
              </button>
            </div>
          )}

          <div className={styles.rulesBox} aria-label="How points work">
            <h2>How points work</h2>
            <ul>
              <li>
                <strong>+{POINTS_RULES.freePer3Min} point</strong> for every 3 minutes you stay free as a Runner (up to{' '}
                {POINTS_RULES.freeMaxPerMatch} per match).
              </li>
              <li>
                <strong>+{POINTS_RULES.neverCaught} points</strong> if you are never caught in a finished match.
              </li>
              <li>
                <strong>+{POINTS_RULES.perTag} points</strong> for every confirmed tag, as a Hunter.
              </li>
              <li>
                <strong>+{POINTS_RULES.cleanSweep} points</strong> for a clean sweep — Hunters catch every Runner (each
                Hunter in that match).
              </li>
            </ul>
            <p className="small">
              Points come only from finished matches. Points are never made up — every point comes from a real match
              on this device. Practice rows below are labelled PRACTICE — practice players from practice rounds on this device, not
              real people, and practice points never count toward a real season.
            </p>
          </div>

          {optedIn ? (
            <>
              <div className={styles.tabs} role="tablist" aria-label="Leaderboard scope">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'world'}
                  className={tab === 'world' ? styles.tabActive : styles.tab}
                  onClick={() => setTab('world')}
                >
                  World
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'country'}
                  className={tab === 'country' ? styles.tabActive : styles.tab}
                  onClick={() => setTab('country')}
                >
                  {myCountry.trim() ? myCountry.trim() : 'Country'}
                </button>
              </div>

              {tab === 'country' && !myCountry.trim() ? (
                <p className="banner">
                  Set your country in your <Link href="/profile">profile</Link> to see your country board.
                </p>
              ) : countryRows.length === 0 ? (
                <div className="card" role="status">
                  <h2 style={{ marginTop: 0 }}>No one on this board yet</h2>
                  <p>
                    {tab === 'country'
                      ? `No opted-in players from ${myCountry.trim()} have finished a match on this device this season.`
                      : 'No opted-in players have finished a match on this device this season.'}{' '}
                    Finish a match to earn points — points are never made up.
                  </p>
                </div>
              ) : (
                <>
                  <ol className={styles.board}>
                    {countryRows.map((row, i) => renderRow(row, i + 1))}
                  </ol>
                  <p className={styles.boardNote}>
                    Showing the top 100 players for {seasonInfo.label}. Ties are broken by finished matches, then by
                    name.
                  </p>
                </>
              )}
            </>
          ) : (
            <>
              {demoRows.length > 0 ? (
                <>
                  <h2 className={styles.practiceHeading}>Practice board — practice players only</h2>
                  <p className={styles.boardNote}>
                    These are practice players from practice rounds on this device, not real people. Join the leaderboard
                    above to see your own row here.
                  </p>
                  <ol className={styles.board}>{demoRows.map((row, i) => renderRow(row, i + 1))}</ol>
                </>
              ) : (
                <div className="card" role="status">
                  <h2 style={{ marginTop: 0 }}>No one on the board yet</h2>
                  <p>
                    No finished matches on this device this season. Finish a match, then join the leaderboard above to
                    see your points here.
                  </p>
                </div>
              )}
            </>
          )}

          {hiddenRealCount > 0 ? (
            <p className="small">
              {hiddenRealCount} other {hiddenRealCount === 1 ? 'player has' : 'players have'} points this season on this
              device but {hiddenRealCount === 1 ? 'has' : 'have'} not opted in here, so {hiddenRealCount === 1 ? 'that player is' : 'they are'}{' '}
              not shown. Nobody is listed without opting in.
            </p>
          ) : null}
          {reportDone ? <p role="status">{reportDone}</p> : null}
          <p className="small">
            {liveConfigured
              ? 'The live leaderboard needs a server route that does not exist yet (GET /v1/leaderboard, opt-in only, display name + points + country). Until it exists, the board only covers games on this device. Report abuse from the board — a report goes to the host/moderation queue, and a formal complaint goes to the '
              : 'The board only covers games on this device. A real board is served from the server, with the same rules: opt-in only, display name + points + country, no locations, no game times. Report abuse from the board — a report goes to the host/moderation queue, and a formal complaint goes to the '}
            <Link href="/grievance">grievance page (Rule 20)</Link>.
          </p>
        </>
      )}

      {reportTarget ? (
        <ReportBlockSheet
          subjectName={reportTarget}
          reporterName={myName || null}
          roomCode={null}
          onClose={() => setReportTarget(null)}
          onFiled={handleReportFiled}
        />
      ) : null}
    </div>
  );
}
