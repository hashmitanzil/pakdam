'use client';
import { useEffect, useMemo, useState } from 'react';
import { listRooms, currentPlayerId } from '@/lib/demo-store';
import type { DemoRoom } from '@/lib/demo-store';
import { isLiveTransportEnabled } from '@/lib/websocket';
import {
  seasonPointsForPlayer,
  playedWith,
  friendsWithHistory,
  toScoringRoom,
} from './leaderboard';
import type { FriendRecord } from './leaderboard';
import ShareRoundCard from './ShareRoundCard';
import styles from './profile.module.css';

const OPTIN_KEY = 'pakdam.leaderboard.optin';
const FRIENDS_KEY = 'pakdam.friends.v1';
const DISPLAY_NAME_KEY = 'pakdam.displayName';
const COUNTRY_KEY = 'pakdam.country';
const ROOMS_KEY = 'pakdam.demo.rooms.v1';
const PUBLIC_ROOMS_KEY = 'pakdam.demo.public-rooms.v1';
const PLAYER_ID_KEY = 'pakdam.playerId';
const HOUSE_PRESETS_KEY = 'pakdam.house-presets.v1';
const ZONE_PRESETS_KEY = 'pakdam.zone-presets.v1';
/** Everything "Delete my local data" removes. Grievance reports,
 *  safety reports and blocked-player records are NOT deleted — they
 *  are accountability records, and the copy below says so. */
const DELETE_KEYS = [
  DISPLAY_NAME_KEY,
  COUNTRY_KEY,
  OPTIN_KEY,
  FRIENDS_KEY,
  ROOMS_KEY,
  PUBLIC_ROOMS_KEY,
  PLAYER_ID_KEY,
  HOUSE_PRESETS_KEY,
  ZONE_PRESETS_KEY,
];

/** Convert a demo room to the scoring input shape — see leaderboard.ts
 *  (single source; ProfileClient only imports it). */
function loadFriends(): FriendRecord[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FRIENDS_KEY) ?? '[]') as FriendRecord[];
    return Array.isArray(raw) ? raw.filter((f) => typeof f.displayName === 'string') : [];
  } catch {
    return [];
  }
}

/** Profile: display name, monthly leaderboard (opt-in, points from real
 *  match data only), friends + "Played with" (last 7 days, real local
 *  history only), and stats from rooms on this device.
 *  localStorage keys: pakdam.displayName, pakdam.demo.rooms.v1,
 *  pakdam.leaderboard.optin, pakdam.friends.v1.
 *  There is NO server board in this demo: opting in records your choice
 *  on this device, and the board shows only you — other players appear
 *  only after they opt in on their own device. No exact locations or
 *  routes are ever shown. */
export default function ProfileClient() {
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [saved, setSaved] = useState(false);
  const [rooms, setRooms] = useState<DemoRoom[]>([]);
  const [loaded, setLoaded] = useState(false);
  /** LIVE mode is configured (NEXT_PUBLIC_WORKER_URL is set) — but no
   *  live route returns this page's data, so the page stays on the
   *  device-local demo store, clearly labelled. What is missing: the
   *  app stores no live seats (create/join never persist a live
   *  roomId/playerId), the Worker has no room-list route, and
   *  GET /v1/rooms/:id (get-state) returns no catches and hides other
   *  seats' roles — so neither points nor round cards can be computed
   *  live. Needed: GET /v1/rooms/:id/results (spec'd in docs/API.md,
   *  HNT-030, not implemented) + a live-seat store or a "my rooms"
   *  route. Never mix demo and live rows. The pure converters for
   *  that route already exist: toScoringRoomFromLive (leaderboard.ts)
   *  and summarizeRoundFromLive / ShareRoundCard `live` (round-card). */
  const [liveConfigured, setLiveConfigured] = useState(false);
  const [optedIn, setOptedIn] = useState(false);
  const [friends, setFriends] = useState<FriendRecord[]>([]);
  const [inviteFrom, setInviteFrom] = useState('');
  const [addName, setAddName] = useState('');
  const [friendNote, setFriendNote] = useState('');
  const [shareRoomId, setShareRoomId] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deletedNote, setDeletedNote] = useState('');

  useEffect(() => {
    setName(localStorage.getItem(DISPLAY_NAME_KEY) ?? '');
    setCountry(localStorage.getItem(COUNTRY_KEY) ?? '');
    setRooms(listRooms());
    setLiveConfigured(isLiveTransportEnabled());
    setOptedIn(localStorage.getItem(OPTIN_KEY) === 'yes');
    setFriends(loadFriends());
    // Friend invite link: /profile?friend=<display name> — the link
    // carries a display name only, never a contact detail.
    const params = new URLSearchParams(window.location.search);
    const invitedBy = params.get('friend')?.trim() ?? '';
    if (invitedBy) setInviteFrom(invitedBy);
    setLoaded(true);
  }, []);

  const myId = currentPlayerId();
  const myRooms = useMemo(
    () => (myId ? rooms.filter((r) => r.players.some((p) => p.playerId === myId)) : []),
    [rooms, myId],
  );
  // All player ids that belong to this device's player (one per room joined).
  const myPlayerIds = useMemo(() => {
    const ids = new Set<string>();
    if (myId) ids.add(myId);
    for (const r of myRooms) {
      const me = r.players.find((p) => p.playerId === myId);
      if (me) ids.add(me.playerId);
    }
    return ids;
  }, [myRooms, myId]);

  const scoringRooms = useMemo(() => rooms.map(toScoringRoom), [rooms]);
  const seasonInfo = useMemo(() => {
    const d = new Date();
    return {
      label: d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
      month: d.getMonth(),
      year: d.getFullYear(),
    };
  }, []);
  const seasonLabel = seasonInfo.label;
  const season = useMemo(
    () => (myId ? seasonPointsForPlayer(scoringRooms, myId, seasonInfo.month, seasonInfo.year) : null),
    [scoringRooms, myId, seasonInfo],
  );
  const playedWithList = useMemo(
    () => playedWith(scoringRooms, myPlayerIds, 7),
    [scoringRooms, myPlayerIds],
  );
  const friendsEnriched = useMemo(
    () => friendsWithHistory(friends, scoringRooms, myPlayerIds),
    [friends, scoringRooms, myPlayerIds],
  );

  const catches = rooms.flatMap((r) => r.catches);
  const gamesPlayed = myRooms.length;
  const gamesCompleted = myRooms.filter((r) => r.room.phase === 'COMPLETED').length;
  const seasonPlayed = myRooms.filter((r) => {
    const d = new Date(r.room.createdAt);
    return d.getMonth() === seasonInfo.month && d.getFullYear() === seasonInfo.year;
  }).length;

  function saveName() {
    localStorage.setItem(DISPLAY_NAME_KEY, name.trim());
    localStorage.setItem(COUNTRY_KEY, country.trim());
    setSaved(true);
  }

  function setOptin(next: boolean) {
    setOptedIn(next);
    localStorage.setItem(OPTIN_KEY, next ? 'yes' : 'no');
  }

  function addFriend(displayName: string) {
    const key = displayName.trim().toLowerCase();
    if (!key || friends.some((f) => f.displayName.trim().toLowerCase() === key)) return;
    const next = [...friends, { displayName: displayName.trim(), addedAt: new Date().toISOString() }];
    setFriends(next);
    localStorage.setItem(FRIENDS_KEY, JSON.stringify(next));
  }

  function shareFriendLink() {
    const me = name.trim();
    if (!me) {
      setFriendNote('Save your display name first — your friend link carries it.');
      return;
    }
    const link = `${window.location.origin}/profile?friend=${encodeURIComponent(me)}`;
    void navigator.clipboard
      ?.writeText(link)
      .then(
        () => setFriendNote(`Friend link copied: ${link} — send it to a friend. When they add you back from their link, you are mutual friends.`),
        () => setFriendNote(`Copy didn’t work in this browser — your friend link is ${link}`),
      );
  }

  function removeFriend(displayName: string) {
    const key = displayName.trim().toLowerCase();
    const next = friends.filter((f) => f.displayName.trim().toLowerCase() !== key);
    setFriends(next);
    localStorage.setItem(FRIENDS_KEY, JSON.stringify(next));
  }

  /** Delete everything Pakdam stored about you on this device: your
   *  display name, country, leaderboard choice, friends, games and
   *  presets, and your player ID. Grievance reports, safety reports
   *  and blocked-player records are NOT deleted (accountability
   *  records — the section copy says so). After deleting, this page
   *  resets to a fresh guest profile. */
  function deleteLocalData() {
    for (const key of DELETE_KEYS) localStorage.removeItem(key);
    // Player identity lives in sessionStorage (per-tab) — clear it
    // here too, or "delete my data" would leave the player signed in
    // to their seat in this tab.
    try { sessionStorage.removeItem(PLAYER_ID_KEY); } catch { /* no session storage — nothing to clear */ }
    setName('');
    setCountry('');
    setOptedIn(false);
    setFriends([]);
    setRooms([]);
    setShareRoomId(null);
    setDeleteArmed(false);
    setDeletedNote(
      'Deleted. This device no longer holds your display name, country, leaderboard choice, friends, games, presets or player ID. Grievance and safety reports were kept, as they are accountability records.',
    );
  }

  const friendKeys = new Set(friends.map((f) => f.displayName.trim().toLowerCase()));

  return (
    <div>
      <div className={styles.hero}>
        <h1>Your profile</h1>
        <p><span className={styles.localNote}>Stored on this device only</span></p>
        <p>Your display name, leaderboard points, friends and stats live on this device only — nothing here is synced to a server. Pakdam is guest-only for now: no account, no sign-in — your friends, presets and leaderboard points stay on this device (sign-in later).</p>
      </div>

      {!loaded ? <p>Loading…</p> : (
        <>
          {liveConfigured ? (
            <div className="banner" role="status">
              <strong>Demo data — live profile not available yet.</strong>
              <p>
                Live mode is configured, but the Worker has no route that returns your games, points or
                round cards, so everything below is still from games on this device only. No live data is
                shown here, and no demo points are mixed into any live record.
              </p>
            </div>
          ) : null}
          <section className="card" aria-label="Display name">
            <h2 className={styles.sectionTitle}>Display name — your codename</h2>
            <p className={styles.sectionSub}>The name other players see in the lobby, on the radio and on the leaderboard. Pick a codename — it doesn’t have to be your real name.</p>
            <label className="label" htmlFor="profile-name">Display name / codename</label>
            <input id="profile-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your display name" />
            <label className="label" htmlFor="profile-country">Country (for the country leaderboard — optional)</label>
            <input id="profile-country" className="input" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="e.g. India" maxLength={56} autoComplete="country-name" />
            <p className="small">Your country is shown on the leaderboard only if you opt in below — and only as a country name, never a place or a location.</p>
            <p><button className="btn btn-secondary" onClick={saveName}>Save display name</button></p>
            {saved ? <p role="status">Display name saved on this device.</p> : null}
          </section>

          <section className="card" aria-label="Monthly leaderboard">
            <h2 className={styles.sectionTitle}>Monthly leaderboard — {seasonLabel}</h2>
            <p className={styles.sectionSub}>One season per month. Opt in to appear on the board; opt out any time and you disappear from future boards.</p>
            <div className={styles.rulesBox} aria-label="How points work">
              <h3>How points work</h3>
              <ul>
                <li><strong>+1 point</strong> for every 3 minutes you stay free as a Runner (up to 10 per match).</li>
                <li><strong>+10 points</strong> if you are never caught in a finished match.</li>
                <li><strong>+3 points</strong> for every confirmed tag, as a Hunter.</li>
                <li><strong>+10 points</strong> for a clean sweep — Hunters catch every Runner (each Hunter in that match).</li>
              </ul>
              <p className="small">Points come only from finished matches on this device. A match that is still going, cancelled or abandoned earns no points. Free time is measured from when Hunters start moving until you are caught, or until the match ends — head-start minutes are not counted, because no separate head-start start time is recorded. Only confirmed tags count; a tag that was disputed or never confirmed earns nothing.</p>
            </div>
            <label className={styles.optinBox}>
              <input
                type="checkbox"
                checked={optedIn}
                onChange={(e) => setOptin(e.target.checked)}
              />
              <span>
                <strong>Show me on the monthly leaderboard</strong>
                <br />
                <span className="small">
                  If you opt in, your display name and your points from finished games appear on the {seasonLabel} board.
                  Your exact location and your routes are never shared — the board only ever shows points and game counts, never where you played.
                  You can opt out any time.
                </span>
              </span>
            </label>
            {optedIn ? (
              <>
                <p role="status">✓ You are opted in for {seasonLabel}.</p>
                {season && season.matchesCounted > 0 ? (
                  <>
                    <div className={styles.statGrid}>
                      <div className={styles.stat}><div className={styles.statLabel}>Your points — {seasonLabel}</div><div className={styles.statValue}>{season.total}</div></div>
                      <div className={styles.stat}><div className={styles.statLabel}>Finished matches counted</div><div className={styles.statValue}>{season.matchesCounted}</div></div>
                    </div>
                    {season.matchesIncompleteData > 0 ? (
                      <p className="small">⚠ {season.matchesIncompleteData} match{season.matchesIncompleteData === 1 ? '' : 'es'} had a missing start or end time, so free-time points could not be measured for {season.matchesIncompleteData === 1 ? 'it' : 'them'}. The other points from {season.matchesIncompleteData === 1 ? 'that match' : 'those matches'} still count. See the notes under each match below.</p>
                    ) : null}
                    {season.matchesSkippedNotFinished > 0 ? (
                      <p className="small">{season.matchesSkippedNotFinished} match{season.matchesSkippedNotFinished === 1 ? ' is' : 'es are'} not finished yet and earn{season.matchesSkippedNotFinished === 1 ? 's' : ''} no points.</p>
                    ) : null}
                    <h3>Your points by match</h3>
                    <table className={styles.pointsTable}>
                      <thead>
                        <tr><th scope="col">Match</th><th scope="col">Role</th><th scope="col">Free</th><th scope="col">Never caught</th><th scope="col">Tags</th><th scope="col">Clean sweep</th><th scope="col">Total</th></tr>
                      </thead>
                      <tbody>
                        {season.byMatch.map((m) => (
                          <tr key={m.roomId}>
                            <td>Room {m.roomCode}<br /><span className="small">{new Date(m.playedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>{m.incompleteData ? <><br /><span className="small">⚠ {m.incompleteReason}</span></> : null}</td>
                            <td>{m.role ?? '—'}</td>
                            <td>{m.freeMinutes === null ? '—' : `${m.freeMinutes} min · ${m.freePoints} pts`}</td>
                            <td>{m.neverCaughtPoints} pts</td>
                            <td>{m.tags} × 3 = {m.tagPoints} pts</td>
                            <td>{m.cleanSweepPoints} pts</td>
                            <td><strong>{m.total} pts</strong></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : (
                  <p>No finished matches on this device in {seasonLabel} yet, so you have 0 points. Finish a match to earn points — points are never made up, they only come from real matches you played.</p>
                )}
                <p className="small">{liveConfigured ? 'The Worker has no leaderboard route yet, so the board shows only you — your points below are from finished games on this device only.' : 'There is no server board yet, so the board shows only you.'} Other players appear only after they opt in on their own device — nobody is listed without opting in, and nobody else&apos;s points are shown here.</p>
              </>
            ) : (
              <p className="small">You are not on the leaderboard. Nothing about you is listed anywhere, and no points are shown for you.</p>
            )}
            <p className="small">Games this season on this device: {seasonPlayed} played. Points above are only from finished matches — see the table.</p>
            <p><a className="btn btn-secondary" href="/leaderboards">See the monthly leaderboard</a></p>
          </section>

          <section className="card" aria-label="Friends">
            <h2 className={styles.sectionTitle}>Friends</h2>
            <p className={styles.sectionSub}>People you add from players you have actually played with, by exact display name, or from a friend link. Friends are mutual when both of you add each other — share your link and ask them to add you back. Your friends list lives on this device only. No contact details are stored — just display names.</p>
            {inviteFrom && !friends.some((f) => f.displayName.trim().toLowerCase() === inviteFrom.trim().toLowerCase()) ? (
              <div className="banner" role="status">
                <strong>{inviteFrom} invited you to be friends.</strong>
                <p>They sent you their friend link. Add them to make it mutual — they add you back from your link.</p>
                <p>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      addFriend(inviteFrom);
                      setFriendNote(`${inviteFrom} added as a friend.`);
                      setInviteFrom('');
                    }}
                  >
                    Add {inviteFrom} as a friend
                  </button>
                </p>
              </div>
            ) : null}
            <label className="label" htmlFor="add-friend-name">Add a friend by exact display name</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                id="add-friend-name"
                className="input"
                style={{ flex: '1 1 200px', margin: 0 }}
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="Their exact display name"
                maxLength={30}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  if (!addName.trim()) {
                    setFriendNote('Type their exact display name first.');
                    return;
                  }
                  if (friends.some((f) => f.displayName.trim().toLowerCase() === addName.trim().toLowerCase())) {
                    setFriendNote(`${addName.trim()} is already your friend.`);
                    return;
                  }
                  addFriend(addName.trim());
                  setFriendNote(`${addName.trim()} added as a friend.`);
                  setAddName('');
                }}
              >
                Add friend
              </button>
            </div>
            <p style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-secondary" onClick={shareFriendLink}>
                Share my friend link
              </button>
            </p>
            {friendNote ? <p role="status" className="small">{friendNote}</p> : null}
            {friendsEnriched.length === 0 ? (
              <p>No friends added yet. Play a game, then add someone from “Played with” below.</p>
            ) : (
              <ul className={styles.friendList}>
                {friendsEnriched.map((f) => (
                  <li key={f.displayName.toLowerCase()}>
                    <div>
                      <strong>{f.displayName}</strong>
                      <br />
                      <span className="small">
                        {f.gamesTogether > 0
                          ? `Played together ${f.gamesTogether} time${f.gamesTogether === 1 ? '' : 's'}${f.lastPlayedAt ? ` · last played ${new Date(f.lastPlayedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}`
                          : 'No shared games on this device yet.'}
                      </span>
                    </div>
                    <button className="btn btn-secondary" onClick={() => removeFriend(f.displayName)}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-label="Played with in the last 7 days">
            <h2 className={styles.sectionTitle}>Played with — last 7 days</h2>
            <p className={styles.sectionSub}>Everyone you shared a game with in the last 7 days, from games on this device. Names only — no locations, no contact details.</p>
            {playedWithList.length === 0 ? (
              <p>No shared games in the last 7 days. Create or join a game to see people here.</p>
            ) : (
              <ul className={styles.friendList}>
                {playedWithList.map((p) => {
                  const isFriend = friendKeys.has(p.displayName.trim().toLowerCase());
                  return (
                    <li key={p.displayName.toLowerCase()}>
                      <div>
                        <strong>{p.displayName}</strong>
                        <br />
                        <span className="small">
                          {p.gamesTogether} game{p.gamesTogether === 1 ? '' : 's'} together · last played {new Date(p.lastPlayedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                          {p.roles.length > 0 ? ` · played as ${p.roles.join(' / ')}` : ''}
                        </span>
                      </div>
                      {isFriend ? (
                        <span className={styles.friendBadge}>✓ Friend</span>
                      ) : (
                        <button className="btn btn-secondary" onClick={() => addFriend(p.displayName)}>Add friend</button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="small">Grouped by display name: the same person rejoining a game gets a new player record, so names are the only way to group people on this device. “Practice” players are practice players added to try the game alone.</p>
          </section>

          <section className="card" aria-label="Your stats">
            <h2 className={styles.sectionTitle}>Your stats (this device only)</h2>
            {rooms.length === 0 ? (
              <p>No games on this device yet. Create or join a game to see stats here.</p>
            ) : (
              <div className={styles.statGrid}>
                <div className={styles.stat}><div className={styles.statLabel}>Games on this device</div><div className={styles.statValue}>{rooms.length}</div></div>
                <div className={styles.stat}><div className={styles.statLabel}>Games you played</div><div className={styles.statValue}>{gamesPlayed}</div></div>
                <div className={styles.stat}><div className={styles.statLabel}>Games completed</div><div className={styles.statValue}>{gamesCompleted}</div></div>
                <div className={styles.stat}><div className={styles.statLabel}>Catches in your rooms</div><div className={styles.statValue}>{catches.length}</div></div>
              </div>
            )}
          </section>

          {myRooms.length > 0 ? (
            <section className="card" aria-label="Your games">
              <h2 className={styles.sectionTitle}>Your games</h2>
              <p className={styles.sectionSub}>Games on this device, newest first. Finished games have a shareable round card — moments and counts only, no locations or routes.</p>
              <ul className={styles.gameList}>
                {myRooms.map((r) => (
                  <li key={r.room.roomId}>
                    <strong>Room {r.room.roomCode}</strong> — {r.room.phase} — {r.players.length} players
                    <br />
                    <span className="small">{new Date(r.room.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} · {new Date(r.room.createdAt).toLocaleTimeString()}</span>
                    {r.room.phase === 'COMPLETED' ? (
                      <>
                        <br />
                        <button
                          type="button"
                          className="btn btn-secondary"
                          style={{ marginTop: 8 }}
                          onClick={() => setShareRoomId(shareRoomId === r.room.roomId ? null : r.room.roomId)}
                          aria-expanded={shareRoomId === r.room.roomId}
                        >
                          {shareRoomId === r.room.roomId ? 'Hide round card' : 'Share round card'}
                        </button>
                        {shareRoomId === r.room.roomId ? <ShareRoundCard room={r} /> : null}
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      <section className="card" aria-label="Account">
        <h2 className={styles.sectionTitle}>No account yet — sign in later</h2>
        <p className={styles.sectionSub}>Pakdam is guest-only for now: no account, no sign-in, no payment, no membership. Everything on this page lives on this device only.</p>
        <p>
          When sign-in arrives, you’ll be able to keep your display name, friends and leaderboard points across devices
          — and choose whether your points carry over. Until then, nothing here leaves this device, and deleting your
          local data below wipes it all.
        </p>
      </section>

      <section className="card" aria-label="Delete my local data">
        <h2 className={styles.sectionTitle}>Delete my local data</h2>
        <p className={styles.sectionSub}>Wipe everything Pakdam stored about you on this device.</p>
        <div className={styles.dangerZone}>
          <h3>This removes, from this device only:</h3>
          <ul style={{ margin: '4px 0 12px', paddingLeft: 20, fontSize: 14 }}>
            <li>Your display name and country</li>
            <li>Your leaderboard opt-in and points</li>
            <li>Your friends list and games on this device</li>
            <li>Your saved presets and your player ID</li>
          </ul>
          <p style={{ fontSize: 14, margin: '4px 0 12px' }}>
            Kept, because they are accountability records: grievance reports, safety reports and your blocked-player
            list. This cannot be undone.
          </p>
          {!deleteArmed ? (
            <p style={{ margin: 0 }}>
              <button type="button" className="btn btn-danger" onClick={() => setDeleteArmed(true)}>
                Delete my local data…
              </button>
            </p>
          ) : (
            <div role="alert">
              <p style={{ margin: '0 0 12px' }}>
                <strong>Are you sure?</strong> This deletes your name, friends, games and points from this device, and
                it cannot be undone.
              </p>
              <p style={{ margin: 0, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-danger" onClick={deleteLocalData}>
                  Yes, delete everything on this device
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setDeleteArmed(false)}>
                  Keep my data
                </button>
              </p>
            </div>
          )}
        </div>
        {deletedNote ? <p role="status">{deletedNote}</p> : null}
      </section>

      <h2>Accessibility settings</h2>
      <p>Large text, high contrast, colour-blind theme, and map style live on the <a href="/accessibility">Accessibility page</a>.</p>
      <p><a href="/safety">Safety</a> · <a href="/help">Help</a> · <a href="/grievance">Grievance</a></p>
    </div>
  );
}
