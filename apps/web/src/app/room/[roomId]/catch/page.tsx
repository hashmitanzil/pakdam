'use client';
import { use, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { getRoom, requestCatch, confirmCatch, disputeCatch, verifyCatchScan, getCatchRaw, currentPlayerId, expireOldCatches, resumePlayer, recordPlayerSuspension } from '@/lib/demo-store';
import { createLivePakdamSocket, getWorkerUrl, type PakdamSocket, type PakdamSocketState } from '@/lib/websocket';
import { getSessionForRoom, type PakdamSession } from '@/lib/session-credentials';
import { CALIBRATION_OPEN } from '@pakdam/shared';
import { describeMode, modeTurnsRunner } from '@pakdam/engine';
import { teamAssignmentLabel } from '@/components/match/ModeZonePanel';
import QrDisplay from '@/components/catch/QrDisplay';
import QrScanner from '@/components/catch/QrScanner';
import CatchFlow from '@/components/match/CatchFlow';
import { lastReportedLabel, pingAgeLabel } from '@/components/match/freshness';
import type { DemoRoom } from '@/lib/demo-store';
import type { CatchView, PlayerView, Room, WsServerMessage, WsSnapshotPayload } from '@pakdam/shared';

/** --- LIVE SEAT (canonical store, lib/session-credentials.ts) ---
 *  The live seat lives in the single sessionStorage key
 *  'pakdam.session.v1', written by the create/join flow with
 *  saveLiveSession and read back here with getSessionForRoom(roomId).
 *  A demo session for this room, or a live session without a
 *  reconnect token, is not a live seat.
 *
 *  The raw reconnect token is never logged, never put in a URL, and
 *  lives only in this tab's sessionStorage. Without it the page cannot
 *  open the live socket (the ticket fetch needs it) and says so
 *  plainly instead of falling back to the demo store.
 *
 *  CATCH-TOKEN CONTRACT (expected — NOT yet implemented server-side):
 *    POST {NEXT_PUBLIC_WORKER_URL}/v1/rooms/{roomId}/catch-token
 *    Body (JSON): { playerId, reconnectToken, catchId }
 *    Auth: the seat's reconnect credential in the JSON body, the same
 *    pattern as POST /v1/rooms/{id}/ws-ticket. No `Authorization`
 *    header, no credential in the query string (a raw credential in a
 *    URL is a leak vector — see lib/websocket.ts).
 *    Success: 200 { token, catchId, expiresAt } — `token` is the raw
 *    one-time catch token for the Runner's QR only; `expiresAt` is an
 *    ISO timestamp. If the Worker omits `expiresAt`, this page falls
 *    back to requestedAt + CALIBRATION_OPEN.catchTokenTtlSeconds.
 *    Errors: 404 no token for this catch and seat; 403 the reconnect
 *    token does not match this seat.
 *    The Durable Object op already exists (`get-catch-token`,
 *    workers/src/room-do-class.ts) but the Worker front door has NO
 *    public route for it yet (workers/src/index.ts routes are only
 *    create / join / start / ws-ticket / ws-ticket-revoke / get-state /
 *    ws). Until the API mission adds the route, the fetch below 404s
 *    and the page says so — the Runner's manual confirm still works,
 *    because it needs no token. This page NEVER invents a token
 *    client-side: a client-made token would not match the server's
 *    hash and the catch could never confirm.
 *
 *  WHO CONFIRMS (server contract, workers/test/workers.test.ts HIGH-1):
 *  only the named Runner may send `catch.confirm`, with the issued
 *  token (or `manualConfirm: true` when the camera is unavailable).
 *  There is NO hunter-sent confirm message in the §3.3 catalogue, so
 *  the Hunter's scan cannot complete the claim by itself against the
 *  server as built — the scan proves the two players were together in
 *  person, and the Runner then confirms on their own phone with the
 *  token they fetched (button under their QR). The claim completes as
 *  resolution 'qr-scan'. If the founder wants the scan ALONE to
 *  complete the claim, the server must accept `catch.confirm` from the
 *  named Hunter when a valid qrToken is supplied (room-do.ts, one
 *  condition) — until then this page wires the path the server
 *  actually accepts and says so.
 *
 *  LIVE LIMITS (server snapshot rules, 17 §3.3): the snapshot carries
 *  only PENDING catches, recipient-filtered (parties + host) — a
 *  confirmed catch never appears in it, so confirmed catches shown
 *  here are the ones this tab saw arrive over the socket. Other
 *  players' match roles are hidden by the server (role secrecy), so
 *  the Hunter's eligibility check cannot see the Runner's role — the
 *  server validates it on `catch.request` and its error is shown.
 *  A disputed catch has no in-app host resolve on the server (the
 *  Runner re-confirming a disputed catch is rejected), so a dispute
 *  is terminal here: the host resolves it in person and the match
 *  continues. */
async function fetchCatchToken(
  apiUrl: string, roomId: string, seat: PakdamSession, catchId: string,
): Promise<{ token: string; expiresAt: string | null }> {
  const r = await fetch(`${apiUrl}/v1/rooms/${roomId}/catch-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: seat.playerId, reconnectToken: seat.reconnectToken, catchId }),
  });
  if (!r.ok) {
    if (r.status === 404) throw new Error('The server does not offer the catch-token route yet (404) — the Runner can still confirm manually below.');
    if (r.status === 403) throw new Error('The server did not accept this seat for the catch token (403) — rejoin the room from the invite link.');
    throw new Error(`Could not get the catch token from the server (${r.status}).`);
  }
  const j = await r.json() as { token?: unknown; data?: { token?: unknown; expiresAt?: unknown }; expiresAt?: unknown };
  const token = typeof j.token === 'string' ? j.token : typeof j.data?.token === 'string' ? j.data.token : null;
  const expiresAt = typeof j.expiresAt === 'string' ? j.expiresAt : typeof j.data?.expiresAt === 'string' ? j.data.expiresAt : null;
  if (!token) throw new Error('The server answered without a catch token — the Runner can still confirm manually below.');
  return { token, expiresAt };
}
/** The QR encodes only the raw one-time token (12 uppercase hex chars,
 *  packages/engine/src/catch.ts `issueCatchToken`). Anything else the
 *  camera decodes is not a Pakdam catch QR. Live, the Hunter cannot
 *  verify a token client-side (the server never sends the hash), so
 *  there is no wrong-scan count or cooldown here — the server
 *  rate-limits confirm attempts instead. */
const CATCH_TOKEN_RE = /^[0-9A-F]{12}$/;

const CLAIM_LABELS: Record<string, string> = {
  requested: 'Requested — claim made, waiting for the Runner',
  'awaiting-confirmation': 'Awaiting confirmation — Runner must show their QR or confirm manually',
  confirmed: 'Confirmed — catch counts',
  disputed: 'Disputed — host review required, match continues',
  rejected: 'Rejected — host or system rejected the claim',
  expired: 'Expired — QR ran out, request a new one',
};

/** Two-step catch, exact founder sequence (2026-11-17):
 *  1. The Hunter tags the Runner IN PERSON (no tech yet).
 *  2. The Runner taps "Got tagged" — their QR opens on their screen.
 *  3. The Hunter scans that QR — the scan COMPLETES the claim
 *     (hunterId + runnerId + time recorded on the catch event).
 *  Fallback when the camera is unavailable: the Runner confirms
 *  themself manually in a dialogue box — no code, no QR needed.
 *  There is no one-time code anywhere in Pakdam: the token lives
 *  only inside the Runner's QR, and the user never sees or types it.
 *  A disputed catch goes to the host to resolve. No auto-confirm on
 *  timeout. GPS is supporting evidence only.
 *  Wrong-scan cooldown (demo only): 3 wrong scans → 30 s lock
 *  (calibration OPEN). Live, the Hunter cannot verify a scan
 *  client-side, so there is no wrong-scan count — see CATCH_TOKEN_RE. */
export default function CatchPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = use(params);
  const search = useSearchParams();
  const runnerId = search.get('runner') ?? '';
  const scanRequested = search.get('scan') === '1';
  const [dr, setDr] = useState<DemoRoom | null>(null);
  const [msg, setMsg] = useState('');
  const [qrOpen, setQrOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [wrongCount, setWrongCount] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [loadError, setLoadError] = useState('');
  // --- live state (used only when NEXT_PUBLIC_WORKER_URL is set) ---
  const [liveMode, setLiveMode] = useState<boolean | null>(null);
  const [seat, setSeat] = useState<PakdamSession | null>(null);
  const [snap, setSnap] = useState<WsSnapshotPayload | null>(null);
  const [conn, setConn] = useState<PakdamSocketState>('idle');
  const [connDetail, setConnDetail] = useState('');
  const [liveError, setLiveError] = useState('');
  const [qrToken, setQrToken] = useState<string | null>(null);
  const [qrExpiresAt, setQrExpiresAt] = useState('');
  const [tokenError, setTokenError] = useState('');
  const [sessionCatches, setSessionCatches] = useState<CatchView[]>([]);
  const [scanDone, setScanDone] = useState(false);
  // Catch-navigation fix (2026-11-19): the Runner picked from the
  // Step 1 picker below (no roles are shown there — names only, the
  // server validates the pick is a Runner). Same effect as ?runner=.
  const [pickedRunnerId, setPickedRunnerId] = useState('');
  const socketRef = useRef<PakdamSocket | null>(null);

  // Decide the mode once: Worker URL set → live only, never the demo
  // store; unset → demo only. The two are never mixed.
  useEffect(() => {
    const live = getWorkerUrl() !== null;
    setLiveMode(live);
    if (live) {
      const stored = getSessionForRoom(roomId);
      const s = stored?.mode === 'live' && stored.reconnectToken ? stored : null;
      setSeat(s);
      if (!s) setLiveError('This room is live, but this device has no seat for it — the reconnect credential was not saved when you joined. Rejoin the room from the invite link.');
    }
  }, [roomId]);

  // Demo polling — demo mode only.
  useEffect(() => {
    if (liveMode !== false) return;
    try { expireOldCatches(roomId); setDr(getRoom(roomId)); } catch { setLoadError('Could not load the catch screen — try again.'); }
    const id = setInterval(() => setDr(getRoom(roomId)), 1000);
    return () => clearInterval(id);
  }, [roomId, liveMode]);

  // Live socket — live mode with a seat only. Snapshot is the whole
  // truth; catch.* events update the session-only confirmed/disputed
  // list (the snapshot never carries those). Commands sent while
  // disconnected are discarded by the socket, never queued.
  useEffect(() => {
    if (liveMode !== true || !seat) return;
    const reconnectToken = seat.reconnectToken;
    if (!reconnectToken) { setLiveError('This room is live, but this device has no seat for it — the reconnect credential was not saved when you joined. Rejoin the room from the invite link.'); return; }
    const socket = createLivePakdamSocket({ roomId, playerId: seat.playerId, reconnectToken });
    if (!socket) { setLiveError('Live transport is configured but the socket could not be built.'); return; }
    socketRef.current = socket;
    void socket.connect(roomId, {
      playerId: seat.playerId,
      onSnapshot: (s) => { setSnap(s); setLiveError(''); },
      onMessage: (m: WsServerMessage) => {
        if (m.type === 'catch.requested' || m.type === 'catch.confirmed' || m.type === 'catch.disputed' || m.type === 'catch.expired' || m.type === 'catch.rejected') {
          const c = (m.payload as { catch: CatchView }).catch;
          setSessionCatches((prev) => [...prev.filter((x) => x.catchId !== c.catchId), c]);
          if (m.type === 'catch.confirmed') setMsg('Catch confirmed — the server recorded who tagged whom and when.');
          if (m.type === 'catch.expired') { setQrToken(null); setMsg('This QR expired — ask the Hunter to request a new one.'); }
          if (m.type === 'catch.rejected') setMsg('The server rejected this catch — the host reviews it in person.');
          if (m.type === 'catch.disputed') setMsg('Catch disputed — the host will review it. The match continues.');
        }
        if (m.type === 'error') setMsg(`Server: ${(m.payload as { message?: string }).message ?? 'the server rejected the last action.'}`);
        if (m.type === 'room.state' || m.type === 'match.completed' || m.type === 'match.cancelled') socket.requestSnapshot();
        if (m.type === 'match.completed') setMsg('Match over — see the results page.');
      },
      onStateChange: (state, detail) => { setConn(state); setConnDetail(detail ?? ''); },
    }).catch(() => {
      setLiveError('Could not connect to the live room — the connection ticket could not be fetched. Check your connection and retry.');
    });
    return () => { socket.close(); socketRef.current = null; };
  }, [roomId, liveMode, seat]);

  const me = liveMode ? seat?.playerId ?? null : currentPlayerId();
  // D-01 (2026-11-19, catch-22 fix, demo half): the Catch screen is
  // the only place a Runner can show their QR / confirm manually, but
  // navigating play → catch suspends them (the play page suspends on
  // hidden), and a suspended Runner can never confirm — so arriving
  // here resumes them, on mount and whenever the tab becomes visible
  // again, mirroring the play page's resume branch. resumePlayer is a
  // no-op unless the player is actually suspended. Demo only: live
  // mode is resumed server-side when the socket says hello.
  useEffect(() => {
    if (liveMode !== false || !me) return;
    if (resumePlayer(roomId, me)) setDr(getRoom(roomId));
    const onVis = () => {
      if (document.hidden) recordPlayerSuspension(roomId, me);
      else if (resumePlayer(roomId, me)) setDr(getRoom(roomId));
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [roomId, liveMode, me]);
  // --- unified view: live snapshot, or the demo store. Never both. ---
  const room: Room | null = liveMode ? snap?.room ?? null : dr?.room ?? null;
  const players: (PlayerView | DemoRoom['players'][number])[] = liveMode ? snap?.players ?? [] : dr?.players ?? [];
  const liveCatches: CatchView[] = (() => {
    const pending = snap?.activeCatches ?? [];
    const byId = new Map<string, CatchView>();
    for (const c of pending) byId.set(c.catchId, c);
    for (const c of sessionCatches) byId.set(c.catchId, c); // session copy wins (confirmed/disputed)
    return [...byId.values()];
  })();
  const catches: (CatchView | DemoRoom['catches'][number])[] = liveMode ? liveCatches : dr?.catches ?? [];
  // Catch-navigation fix (2026-11-19) — the Runner is NO LONGER
  // only the ?runner= param. Effective runner, in order:
  //   1. ?runner= (roster Catch link, hunter pre-claim),
  //   2. an open claim involving ME — as Runner (auto-select: the
  //      Runner taps the bare CatchPanel link and lands on their own
  //      Step 2) or as Hunter (bare link returns to my open claim's
  //      Step 3). No role is leaked: the claim is already visible to
  //      both parties (and the host) in the snapshot.
  //   3. the Step 1 picker choice below (pickedRunnerId).
  //   4. my most recent CONFIRMED catch involving me (so the
  //      "✓ Catch confirmed" card survives the claim leaving the
  //      pending set — see myLatestConfirmed below).
  // With none of those, there is no runner and the Step 1 picker
  // renders instead of the "No Runner selected" dead end.
  const myPendingClaim = me ? catches.find((c) => (c.state === 'requested' || c.state === 'awaiting-confirmation') && (c.runnerPlayerId === me || c.hunterPlayerId === me)) : undefined;
  const autoRunnerId = myPendingClaim?.runnerPlayerId ?? '';
  // The pending auto-select evaporates the moment the claim confirms
  // (a confirmed catch is no longer pending) — without a fallback the
  // Runner's page would drop back to the Step 1 picker instead of the
  // "✓ Catch confirmed" card. So a confirmed catch involving ME also
  // pins the runner (most recent first). Same visibility as the
  // pending claim: only catches this seat is a party to.
  const myLatestConfirmed = me ? [...catches].reverse().find((c) => c.state === 'confirmed' && (c.runnerPlayerId === me || c.hunterPlayerId === me)) : undefined;
  const confirmedRunnerId = myLatestConfirmed?.runnerPlayerId ?? '';
  const effectiveRunnerId = runnerId || autoRunnerId || pickedRunnerId || confirmedRunnerId;
  // Picker list (hunter pre-claim, Step 1): display names ONLY — no
  // roles, because live mode masks other players' roles and this
  // client must not (and cannot) know them. Exclusions are not role
  // filters: self (cannot catch yourself), ejected / left players,
  // and already-caught Runners (the server rejects all of those
  // anyway). A pick that turns out not to be a Runner is rejected by
  // the server on catch.request and its plain-language error is
  // shown — no role is revealed by the rejection.
  const confirmedRunnerIds = new Set(catches.filter((c) => c.state === 'confirmed').map((c) => c.runnerPlayerId));
  const pickerPlayers = players.filter((p) => p.playerId !== me && !p.ejectedAt && !p.leftAt && !confirmedRunnerIds.has(p.playerId));
  const pickedFromPicker = !runnerId && !autoRunnerId && pickedRunnerId !== '';
  // The open claim's id, computed before the early returns so the two
  // effects below run in the same order on every render (hooks must
  // never sit after a conditional return).
  const pendingId = catches.find((c) => c.runnerPlayerId === effectiveRunnerId && (c.state === 'awaiting-confirmation' || c.state === 'requested'))?.catchId;
  // Deep link from the play screen's Scan QR button: open the scanner
  // as soon as the open claim has loaded.
  useEffect(() => {
    if (scanRequested && pendingId) setScannerOpen(true);
  }, [scanRequested, pendingId]);
  // A new claim resets the Runner's QR + manual dialogue.
  useEffect(() => { setQrOpen(false); setManualOpen(false); setWrongCount(0); setQrToken(null); setScanDone(false); setTokenError(''); }, [pendingId]);
  // Focus follows the QR toggle: "Got tagged" unmounts when the QR
  // opens and "Hide my QR" unmounts when it closes — without this,
  // keyboard focus would drop to the top of the page on every tap.
  const qrToggleRef = useRef<HTMLButtonElement>(null);
  const prevQrOpenRef = useRef(false);
  useEffect(() => {
    if (prevQrOpenRef.current !== qrOpen) { prevQrOpenRef.current = qrOpen; qrToggleRef.current?.focus(); }
  }, [qrOpen]);
  // Focus follows the manual-confirm dialogue: when it opens, focus
  // lands on the "Yes, I was tagged" button.
  const manualYesRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (manualOpen) manualYesRef.current?.focus(); }, [manualOpen]);

  if (liveMode === null) return <div aria-busy="true"><h1>Preparing the catch screen…</h1><div className="skeleton skeleton-lg" aria-hidden="true" /><p>Loading the catch screen.</p></div>;
  if (liveMode && !seat) return <div><h1>Catch</h1><p role="alert">{liveError || 'This room is live, but this device has no seat for it.'}</p><p><a className="btn" href="/">Back to home</a></p></div>;
  if (liveMode && liveError && !snap) return <div><h1>Catch</h1><p role="alert">{liveError}</p><p><button className="btn" onClick={() => { setLiveError(''); const s = socketRef.current; if (s) void s.retry(); else window.location.reload(); }}>Retry</button></p></div>;
  if (liveMode && !snap) return <div aria-busy="true"><h1>Connecting to the live room…</h1><div className="skeleton skeleton-lg" aria-hidden="true" /><p>Live room — waiting for the server snapshot{conn !== 'idle' && conn !== 'connected' ? ` (${conn}${connDetail ? ` — ${connDetail}` : ''})` : ''}.</p></div>;
  if (!liveMode && loadError) return <div><h1>Catch</h1><p role="alert">{loadError}</p><p><button className="btn" onClick={() => { setLoadError(''); setDr(getRoom(roomId)); }}>Retry</button></p></div>;
  if (!liveMode && !dr) return <div aria-busy="true"><h1>Preparing the catch screen…</h1><div className="skeleton skeleton-lg" aria-hidden="true" /><div className="skeleton" style={{ width: '60%' }} aria-hidden="true" /><p>Loading the catch screen.</p></div>;
  if (!room) return <div><h1>Catch</h1><p role="alert">Could not load this room.</p><p><a className="btn" href="/">Back to home</a></p></div>;
  const runner = players.find((p) => p.playerId === effectiveRunnerId);
  const hunter = players.find((p) => p.playerId === me);
  const pending = catches.find((c) => c.runnerPlayerId === effectiveRunnerId && (c.state === 'awaiting-confirmation' || c.state === 'requested'));
  const latestConfirmed = catches.find((c) => c.runnerPlayerId === effectiveRunnerId && c.state === 'confirmed');
  const amRunner = me === effectiveRunnerId;
  const amHost = room.hostPlayerId === me;
  const coolingDown = Date.now() < cooldownUntil;
  // Live, the Runner's role is visible only to the Runner themself
  // (role secrecy) — a Hunter cannot see it, so the check below uses
  // only what the server shows everyone. The server still validates
  // the role on catch.request and its error is shown.
  const eligible = room.phase === 'ACTIVE' && runner?.connectionState !== 'suspended' && !runner?.ejectedAt && (liveMode ? true : runner?.matchRole === 'runner');
  const flowStep: 0 | 1 | 2 | 3 = !pending ? (latestConfirmed ? 3 : 0) : qrOpen ? 2 : 1;

  const start = () => {
    if (!me) return;
    if (!eligible) { setMsg('No Runner is eligible to catch right now — the match must be active and the Runner must not be suspended or ejected.'); return; }
    if (liveMode) {
      const sock = socketRef.current;
      if (!sock || !sock.sendCommand('catch.request', { runnerId: effectiveRunnerId })) {
        setMsg('Not connected to the live room — the catch was not sent. Wait for the connection to return and try again.');
        return;
      }
      setMsg('Catch requested. The Runner taps “Got tagged” on their own phone to show their QR — scan it to complete the tag.');
      return;
    }
    try { requestCatch(roomId, me, effectiveRunnerId); setMsg('Catch requested. The Runner taps “Got tagged” on their own phone to show their QR — scan it to complete the tag.'); } catch (e) { setMsg(e instanceof Error ? e.message : 'Could not request a catch'); }
  };
  /** Live: fetch the server-issued token and open the Runner's QR.
   *  No token is ever invented here — without the server's token
   *  there is no QR, and the manual confirm below is the fallback. */
  const showQr = async () => {
    if (!pending || !seat || !seat.reconnectToken) return;
    const apiUrl = getWorkerUrl();
    if (!apiUrl) return;
    setTokenError('');
    try {
      const { token, expiresAt } = await fetchCatchToken(apiUrl, roomId, seat, pending.catchId);
      setQrToken(token);
      setQrExpiresAt(expiresAt ?? new Date(new Date(pending.requestedAt).getTime() + CALIBRATION_OPEN.catchTokenTtlSeconds * 1000).toISOString());
      setQrOpen(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not get the live QR from the server.';
      setTokenError(message);
      setMsg(`${message} The manual confirm below still works.`);
    }
  };
  /** The Hunter's scan. Demo: the token is verified against the open
   *  claim, and a match records hunterId + runnerId + the scan time
   *  (confirmedAt) on the catch event. A scan that does not match
   *  counts as a wrong attempt, with the same 3-wrong-attempts
   *  cooldown. The tag itself already happened in person — the scan
   *  only proves it.
   *  Live: the scan decodes the Runner's one-time token, but only the
   *  named Runner may send `catch.confirm` to the server — so the scan
   *  proves the two players were together in person and the Runner
   *  confirms on their own phone (button under their QR) with the
   *  token they fetched. The claim then completes as 'qr-scan'. */
  const verifyScan = (raw: string) => {
    if (!pending) return;
    if (liveMode) {
      const token = raw.trim().toUpperCase();
      if (!CATCH_TOKEN_RE.test(token)) {
        setMsg('That QR is not a Pakdam catch QR — make sure the Runner is showing the QR from this catch, then try again.');
        return;
      }
      setScanDone(true);
      setMsg(`QR scanned — this is ${runner?.displayName ?? 'the Runner'}’s live catch QR. The Runner confirms on their own phone to complete the tag.`);
      return;
    }
    if (coolingDown) { setMsg(`Too many wrong scans — try again in ${Math.ceil((cooldownUntil - Date.now()) / 1000)} seconds.`); return; }
    if (verifyCatchScan(roomId, pending.catchId, raw.trim().toUpperCase())) {
      setWrongCount(0);
      // The scan verified the Runner's QR; the confirm still needs the
      // claiming Hunter as actor (demo-store authenticates it), and it
      // can fail if the claim expired or the match ended underneath us.
      try {
        confirmCatch(roomId, pending.catchId, 'qr-scan', me ?? undefined);
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Could not confirm this catch');
        return;
      }
      setDr(getRoom(roomId));
      setMsg(`QR scanned — catch confirmed. ${hunter?.displayName ?? 'The Hunter'} tagged ${runner?.displayName ?? 'the Runner'}.`);
    } else {
      const n = wrongCount + 1;
      setWrongCount(n);
      if (n >= 3) {
        setCooldownUntil(Date.now() + 30000);
        setMsg('Too many wrong scans — try again in 30 seconds. Wrong scans are rate-limited and audited. (Cooldown length: calibration OPEN.)');
      } else {
        setMsg(`That QR did not match this claim — try again (${n} of 3 wrong scans). Wrong scans are rate-limited and audited.`);
      }
    }
  };
  /** Live, Runner confirms with the token they fetched: the server
   *  checks it against the hash from `catch.request` and the claim
   *  completes as 'qr-scan'. */
  const confirmWithQr = () => {
    if (!pending || !qrToken) return;
    const sock = socketRef.current;
    if (!sock || !sock.sendCommand('catch.confirm', { catchId: pending.catchId, qrToken })) {
      setMsg('Not connected to the live room — the confirm was not sent. Wait for the connection to return and try again.');
      return;
    }
    setMsg('Confirm sent — waiting for the server to confirm the catch.');
  };
  const confirmManually = () => {
    if (!pending) return;
    if (liveMode) {
      // The shared `catch.confirm` type only lists qrToken, but the
      // server also accepts `manualConfirm: true` with no token (GL-04)
      // — the Runner confirming themself when the camera is
      // unavailable. qrToken is sent empty so the type stays honest.
      const payload = { catchId: pending.catchId, qrToken: '', manualConfirm: true } as unknown as { catchId: string; qrToken: string };
      const sock = socketRef.current;
      if (!sock || !sock.sendCommand('catch.confirm', payload)) {
        setMsg('Not connected to the live room — the confirm was not sent. Wait for the connection to return and try again.');
        return;
      }
      setManualOpen(false);
      setMsg('Manual confirm sent — waiting for the server to confirm the catch.');
      return;
    }
    // Manual confirm is the named Runner's own consent (demo-store
    // enforces Runner-only) — it can fail if the claim expired or the
    // match ended underneath us.
    try {
      confirmCatch(roomId, pending.catchId, 'manual-confirm', me ?? undefined);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not confirm this catch');
      return;
    }
    setManualOpen(false);
    setDr(getRoom(roomId));
    setMsg('Catch confirmed manually — the camera could not scan, so the Runner confirmed themself.');
  };
  const dispute = () => {
    if (!pending) return;
    if (liveMode) {
      const sock = socketRef.current;
      if (!sock || !sock.sendCommand('catch.dispute', { catchId: pending.catchId, reason: 'Runner disputes this catch — the host reviews it in person.' })) {
        setMsg('Not connected to the live room — the dispute was not sent. Wait for the connection to return and try again.');
        return;
      }
      setMsg('Dispute sent — the host will review it. The match continues.');
      return;
    }
    // Dispute is Runner-only in the demo store (like the server) and
    // can fail if the claim already expired or resolved underneath us.
    try {
      disputeCatch(roomId, pending.catchId, me ?? undefined);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not dispute this catch');
      return;
    }
    setMsg('Catch disputed — the host will review it. The match continues.');
  };

  return (
    <div>
      <h1>Catch — {runner?.displayName ?? 'Runner'}</h1>
      {liveMode ? (
        <p className="small">Live room — this screen shows the server’s state. {conn === 'connected' ? 'Connected.' : conn === 'connecting' ? 'Connecting…' : conn === 'reconnecting' ? 'Connection lost — reconnecting… nothing is sent while offline.' : conn === 'reconnect-failed' ? 'Reconnect failed.' : conn === 'closed' ? 'Connection closed.' : ''}{conn === 'reconnect-failed' || conn === 'closed' ? <> <button type="button" className="btn btn-secondary" onClick={() => void socketRef.current?.retry()}>Retry connection</button></> : null}{liveError ? ` ${liveError}` : ''}</p>
      ) : (
        <p className="small">Demo room — local only, not a live game.</p>
      )}
      <CatchFlow step={flowStep} stateLabel={pending ? (CLAIM_LABELS[pending.state] ?? pending.state) : latestConfirmed ? 'Confirmed — catch counts' : 'No claim yet'} />
      <p className="small">No grabbing, blocking, tackling or forced phone handling. GPS proximity is supporting evidence only — it never proves a catch.</p>
      <p className="small">Mode: {describeMode(room.config.mode).label} · {teamAssignmentLabel(room.config.teamAssignment)}{room.config.teamAssignment === 'selected' ? ` — the host picked the Hunters` : room.config.teamAssignment === 'random' ? ' — Hunters were drawn at random when the game started' : ''}. {modeTurnsRunner(room.config.mode) ? 'In this mode, a confirmed catch flips this Runner to Hunter.' : 'In this mode, a confirmed catch takes the Runner out.'}</p>
      {runner ? <p>{runner.displayName} — {runner.connectionState === 'suspended' ? `Suspended — location unknown · ${lastReportedLabel(runner.lastFixAt)}` : lastReportedLabel(runner.lastFixAt)} · GPS evidence on this claim: {pending?.gpsEvidence ?? 'absent'}</p> : <p role="alert">No Runner selected yet — pick a player below to claim a catch.</p>}
      {room.phase !== 'ACTIVE' ? <p className="small">The match is {room.phase} — catches are only available while the match is active.</p> : null}

      {!pending ? (
        latestConfirmed ? (
          <div className="card" role="status">
            <h2 style={{ marginTop: 0 }}>✓ Catch confirmed</h2>
            <p>{hunter?.displayName ?? 'The Hunter'} tagged {runner?.displayName ?? 'the Runner'}{latestConfirmed.confirmedAt ? ` at ${new Date(latestConfirmed.confirmedAt).toLocaleTimeString()}` : ''}{latestConfirmed.resolution === 'qr-scan' ? ' — completed by QR scan.' : latestConfirmed.resolution === 'manual-confirm' ? ' — confirmed manually (camera unavailable).' : '.'}</p>
            <p className="small">The claim is complete. A disputed catch would go to the host — this one was not disputed.</p>
          </div>
        ) : (
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Step 1 — Claim the catch</h2>
            {!runner ? (
              <div>
                <p>Pick a player to claim you tagged them in person. Names only — the server checks your pick is a Runner in this room, and says so in plain language if it is not.</p>
                {pickerPlayers.length === 0 ? (
                  <p>No players are available to catch right now.</p>
                ) : (
                  <ul style={{ listStyle: 'none', padding: 0 }}>
                    {pickerPlayers.map((p) => (
                      <li key={p.playerId} style={{ padding: '4px 0' }}>
                        <button type="button" className="btn btn-secondary" style={{ width: '100%', minHeight: 52 }} onClick={() => setPickedRunnerId(p.playerId)}>Catch {p.displayName}</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <>
                <p>Tap below to claim you tagged {runner.displayName} in person. The Runner then taps “Got tagged” on their own phone and shows their QR — you scan it to complete the tag.</p>
                {pickedFromPicker ? <p><button type="button" className="btn btn-secondary" onClick={() => setPickedRunnerId('')}>Change Runner — pick someone else</button></p> : null}
                {/* Never disabled: a tap always answers in plain language
                    (start() explains why a catch is not possible right
                    now) or requests the catch. */}
                <p><button className="btn" onClick={start} aria-disabled={!eligible} style={{ width: '100%', padding: 16, fontSize: 18 }}>Request a catch</button></p>
                {!eligible ? <p className="small">Catch is disabled: {runner.ejectedAt ? 'the Runner was ejected from the game.' : runner.connectionState === 'suspended' ? 'the Runner is suspended — they must reopen the PWA first; a catch cannot complete until they show their QR or confirm manually.' : 'the match is not active.'}</p> : null}
              </>
            )}
          </div>
        )
      ) : (
        <div>
          <p>Claim state: <span className={`claim-state claim-${pending.state}`}>{CLAIM_LABELS[pending.state] ?? pending.state}</span> <span className="small">· requested {pingAgeLabel(pending.requestedAt)}</span></p>
          <p className="small">Step 1 of 3 — claim made by {hunter?.displayName ?? 'a Hunter'} after the in-person tag. Step 2 — the Runner taps “Got tagged” and shows their QR. Step 3 — the Hunter scans it to complete the tag, or the Runner confirms manually if the camera is unavailable. A disputed catch goes to the host to resolve; it is not confirmed until resolution completes.</p>

          {amRunner ? (
            <div>
              <div className="card" style={{ border: '2px solid #B91C1C' }}>
                <h2 style={{ marginTop: 0 }}>Step 2 — You are the Runner</h2>
                <p>The Hunter tagged you in person. Tap “Got tagged” to show your QR — the Hunter scans it to complete the tag. Dispute only if they did not tag you.</p>
                {!qrOpen ? (
                  <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button ref={qrToggleRef} className="btn" style={{ flex: 1, minHeight: 52 }} onClick={() => { if (liveMode) void showQr(); else setQrOpen(true); }}>✓ Got tagged — show my QR</button>{' '}
                    <button className="btn btn-secondary" style={{ flex: 1, minHeight: 52 }} onClick={dispute}>Dispute</button>
                  </p>
                ) : (
                  <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button ref={qrToggleRef} className="btn btn-secondary" style={{ flex: 1, minHeight: 48 }} onClick={() => { setQrOpen(false); setQrToken(null); }}>Hide my QR</button>{' '}
                    <button className="btn btn-secondary" style={{ flex: 1, minHeight: 48 }} onClick={dispute}>Dispute</button>
                  </p>
                )}
              </div>
              {tokenError && !qrOpen ? <p role="alert">{tokenError}</p> : null}
              {qrOpen ? (
                <div>
                  {liveMode ? (
                    qrToken ? (
                      <div>
                        <QrDisplay token={qrToken} expiresAt={qrExpiresAt} />
                        <p className="small">The QR appears only on the Runner&apos;s own phone, after they tap “Got tagged”. QR lifetime: {CALIBRATION_OPEN.catchTokenTtlSeconds} s (calibration OPEN).</p>
                        <p><button type="button" className="btn" style={{ minHeight: 52, width: '100%' }} onClick={confirmWithQr}>✓ Hunter scanned my QR — confirm the catch</button></p>
                        {scanDone ? <p className="small">The Hunter scanned your QR — tap above to complete the tag.</p> : <p className="small">Ask the Hunter to scan your QR, then tap above to complete the tag. The server only accepts the confirm from you, with this QR’s token.</p>}
                      </div>
                    ) : (
                      <p role="status">Getting your QR from the server…</p>
                    )
                  ) : (
                    <div>
                      <QrDisplay token={getCatchRaw(pending.catchId) ?? '------'} expiresAt={new Date(new Date(pending.requestedAt).getTime() + CALIBRATION_OPEN.catchTokenTtlSeconds * 1000).toISOString()} />
                      <p className="small">The QR appears only on the Runner&apos;s own phone, after they tap “Got tagged”. QR lifetime: {CALIBRATION_OPEN.catchTokenTtlSeconds} s (calibration OPEN).</p>
                    </div>
                  )}
                  <div className="card">
                    <h2 style={{ marginTop: 0 }}>Hunter&apos;s camera can&apos;t scan?</h2>
                    <p className="small" style={{ marginTop: 0 }}>That is the fallback — confirm yourself manually instead. No QR and no code needed for this path.</p>
                    {!manualOpen ? (
                      <p><button type="button" className="btn btn-secondary" onClick={() => setManualOpen(true)} style={{ minHeight: 52, width: '100%' }}>Confirm manually — camera unavailable</button></p>
                    ) : (
                      <div role="dialog" aria-label="Confirm you were tagged">
                        <p><strong>Confirm you were tagged?</strong> Only confirm if the Hunter really tagged you in person.</p>
                        <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button ref={manualYesRef} type="button" className="btn" style={{ flex: 1, minHeight: 52 }} onClick={confirmManually}>Yes, I was tagged</button>{' '}
                          <button type="button" className="btn btn-secondary" style={{ flex: 1, minHeight: 52 }} onClick={() => setManualOpen(false)}>Cancel</button>
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="card">
              <h2 style={{ marginTop: 0 }}>Step 3 — Scan the Runner&apos;s QR</h2>
              <p className="small" style={{ marginTop: 0 }}>The tag already happened in person — the scan only proves it. Ask the Runner to tap “Got tagged” and hold up their QR, then scan it. A matching scan completes the claim: who tagged whom, and when, is recorded on the catch event.</p>
              {scannerOpen ? (
                <QrScanner onScanned={(token) => { setScannerOpen(false); verifyScan(token); }} onClose={() => setScannerOpen(false)} />
              ) : (
                /* Never disabled: a tap during cooldown answers with
                   the wait time instead of silently doing nothing. */
                <p><button type="button" className="btn" onClick={() => { if (!liveMode && coolingDown) { setMsg(`Too many wrong scans — try again in ${Math.ceil((cooldownUntil - Date.now()) / 1000)} seconds.`); return; } setScannerOpen(true); }} aria-disabled={!liveMode && coolingDown} style={{ minHeight: 52, width: '100%' }}>📷 Scan the Runner’s QR</button></p>
              )}
              {!liveMode && coolingDown ? <p role="status">Cooling down — try again in {Math.ceil((cooldownUntil - Date.now()) / 1000)} s.</p> : null}
              {!liveMode && wrongCount > 0 && !coolingDown ? <p className="small">{wrongCount} of 3 wrong scans used.</p> : null}
              {liveMode && scanDone ? <p role="status">QR scanned — the Runner confirms on their own phone to complete the tag.</p> : null}
              <p className="small">If your camera can&apos;t scan, the Runner confirms manually on their own phone instead — that is the fallback, not a code. There is no code in Pakdam.</p>
            </div>
          )}
          {amHost && pending.state === 'disputed' ? <p className="small">You are the host: review the dispute with the players in person. Confirming a disputed catch is done by the Runner re-confirming; there is no automatic tag on inconclusive evidence.</p> : null}
        </div>
      )}
      {msg ? <p role="status">{msg}</p> : null}
      <h2>Catches in this room</h2>
      {liveMode ? <p className="small">Live: the server sends pending catches only to the players involved (and the host) — confirmed catches below are the ones this device saw arrive while connected.</p> : null}
      {catches.length === 0 ? <p>No catches yet.</p> : (
        <ul style={{ listStyle: 'none', padding: 0 }}>{catches.map((c) => {
          const h = players.find((p) => p.playerId === c.hunterPlayerId);
          const r = players.find((p) => p.playerId === c.runnerPlayerId);
          return <li key={c.catchId} style={{ padding: '8px 0', borderBottom: '1px solid #E8CFCF' }}><span className={`claim-state claim-${c.state}`}>{CLAIM_LABELS[c.state] ?? c.state}</span> — {h?.displayName ?? 'Hunter'} → {r?.displayName ?? 'Runner'} (GPS evidence: {c.gpsEvidence}) · requested {new Date(c.requestedAt).toLocaleTimeString()}{c.state === 'confirmed' && c.confirmedAt ? ` · confirmed ${new Date(c.confirmedAt).toLocaleTimeString()}${c.resolution === 'qr-scan' ? ' by QR scan' : c.resolution === 'manual-confirm' ? ' manually (camera unavailable)' : ''}` : ''} · {pingAgeLabel(c.requestedAt)}</li>;
        })}</ul>
      )}
      <p><a className="btn btn-secondary" href={`/room/${roomId}/play`}>Back to game</a></p>
    </div>
  );
}
