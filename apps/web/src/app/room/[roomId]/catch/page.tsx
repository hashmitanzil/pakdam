/**
 * Catch — the QR catch flow (SCRAM-SPEC §9, PROTOCOL-MAP §4.7, P0-2).
 *
 * Tag → QR → runner confirms → manual fallback. NO catch code anywhere:
 * the token lives only inside the Runner's QR and is never shown or typed.
 *
 * V18 founder flow — two ways to finish a tag:
 * WAY 1 — QR scan. The Runner taps "Got Tagged" and the catch screen
 * opens with their QR ALREADY SHOWING (no extra tap — it mints
 * automatically with no claim open, via WS `catch.runner-token` live /
 * the engine's `issueRunnerQrToken` in demo, and refreshes itself every
 * 120 s; with an open claim the claim's QR shows instead). The Hunter
 * taps "Tag a runner" and gets the CAMERA running at the top with a
 * column BELOW it: they scan the Runner's QR (WS `catch.request` with
 * the raw token, no runnerId), the claim lands, the scanned Runner
 * appears in the column with a Tag button, and Tag confirms the tag
 * ("✓ Catch confirmed"). The name picker lives in that same column as
 * the manual fallback when the camera/scan cannot be used — pick a name
 * → claim → the Runner confirms on their phone (Self confirm), no QR
 * needed.
 * WAY 2 — SELF CONFIRM. Below the QR, the Runner taps "Self confirm",
 * picks the Hunter who tagged them from a sheet, taps OK — the tag
 * completes right there via `catch.self-confirm` (live) / `selfConfirm-
 * Catch` (demo). NO confirmation is needed from the Hunter.
 *
 * Auto-select (`resolveEffectiveRunner` in demo; the same order in live):
 * `?runner=` param → my open claim → picker choice → my latest confirmed
 * catch → the name-only picker. Never a "No Runner selected" dead end.
 *
 * Suspended Runners block confirm (server gate) — the page surfaces the
 * reason in one line instead of a silent disabled button. Disputes are
 * paused for now — the Runner confirms with Self confirm; the host's
 * dispute review stays in place for any disputed catch.
 *
 * Works in both modes: live (server-authoritative over the socket) and
 * demo (local demo-store). P0-1: demo resumes a suspended player on
 * catch-page arrival; live resumes on hello/reconnect (server-side).
 */
'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRoomState } from '@/components/match/useRoomState';
import { CatchQR } from '@/components/catch/CatchQR';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ErrorBoundaryThrowTest } from '@/components/ErrorBoundaryThrowTest';
import { ClaimPicker } from '@/components/catch/ClaimPicker';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { fetchLiveCatchToken } from '@/lib/live-client';
import { resolveLiveCatch } from '@/lib/live-room-client';
import { clearRejoinToken } from '@/lib/rejoin-token';
import { getSessionForRoom } from '@/lib/session-credentials';
import { goHomeAfterRoomDeleted } from '@/lib/room-deleted';
import { formatClock } from '@/lib/utils';
import {
  confirmCatch,
  getCatchRaw,
  getRoom,
  listCatchPickerNames,
  mintRunnerQrToken,
  rejectCatch,
  requestCatch,
  resolveEffectiveRunner,
  resumePlayerOnCatchPageArrival,
  scanRunnerQrToken,
  selfConfirmCatch,
  verifyCatchScan,
} from '@/lib/demo-store';

export default function CatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ roomId: string }>;
  searchParams: Promise<{ runner?: string; scan?: string; errorBoundaryTest?: string }>;
}) {
  const { roomId } = use(params);
  const query = use(searchParams);
  // TEST-ONLY (`e2e/error-boundary.spec.ts`): renders the throwing test
  // component inside the catch boundary so the fallback can be asserted.
  // Never set in normal use.
  const errorBoundaryTestCatch = query?.errorBoundaryTest === 'catch';
  const router = useRouter();

  const {
    mode,
    room,
    players,
    phase,
    activeCatches,
    sessionCatches,
    socket,
    socketState,
    lastSocketError,
    lastRunnerToken,
    demo,
    myPlayerId,
    myPlayer,
    loading,
    error,
    roomDeleted,
    seatRemoved,
    retryConnection,
    refreshDemo,
  } = useRoomState(roomId);

  const [pickerChoice, setPickerChoice] = useState<string | null>(null);
  // Manual fallback: force the name picker into the column below the
  // camera even while a claim is open (to pick a different Runner).
  const [manualMode, setManualMode] = useState(false);
  const [qrToken, setQrToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The Hunter's scanned QR token, held until they tap Tag. A scan never
  // confirms on its own — Tag is the confirm step (Way 1).
  const [scannedToken, setScannedToken] = useState<string | null>(null);
  // Live only: Tag was tapped with no open claim yet — the claim request
  // is sent, and the held token confirms the moment the claim lands.
  const [tagAfterClaim, setTagAfterClaim] = useState(false);
  const tagTargetRef = useRef<string | null>(null);
  // Self Confirm sheet (Way 2): which Hunter the Runner picked, if any.
  const [selfConfirmOpen, setSelfConfirmOpen] = useState(false);
  const [selfConfirmHunterId, setSelfConfirmHunterId] = useState<string | null>(null);
  // A4: "Confirming…" shows the instant Self confirm is tapped — the
  // done card renders on the server echo (live) or the store write
  // (demo); a failed confirm clears it and says so.
  const [confirming, setConfirming] = useState(false);
  // (b) A live confirm/scan that the server REJECTS (stale GPS, >100 m,
  // already decided, expired) arrives only as an error envelope — the
  // page used to never read it, so the Runner wedged on "Confirming…"
  // with the button disabled and no message. These refs tie a fresh
  // error envelope to the pending catch action that caused it; the
  // timeout is the fallback if no envelope ever arrives.
  const pendingConfirmAtMsRef = useRef<number | null>(null);
  const pendingScanAtMsRef = useRef<number | null>(null);
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearConfirmTimeout = () => {
    if (confirmTimeoutRef.current) {
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }
    pendingConfirmAtMsRef.current = null;
  };
  const [doneCatchId, setDoneCatchId] = useState<string | null>(null);
  // The done card falls back to the latest confirmed catch (so it survives
  // the claim leaving the pending set) — but "Tag someone else" must be
  // able to escape it, or the hunter can never tag a second runner: the
  // dismissed catch id is excluded from the fallback until a new catch
  // confirms (which re-arms the card).
  const [dismissedDoneCatchId, setDismissedDoneCatchId] = useState<string | null>(null);
  const [hostNote, setHostNote] = useState<string | null>(null);
  // v18 auto-QR — the Runner's own claim-less token (no open claim):
  // the raw token + its expiry, held only while this screen shows it.
  // Never rendered as text, never stored beyond the screen.
  const [mintedToken, setMintedToken] = useState<{ token: string; expiresAt: string } | null>(null);
  // A mint that failed, in the server's plain words, with a retry.
  const [mintFailed, setMintFailed] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const mintInFlightRef = useRef(false);
  const pendingMintAtMsRef = useRef<number | null>(null);
  // Countdown clock for the minted QR (1 s ticker while it shows).
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Hunter scan in flight: the raw token sent with `catch.request`,
  // awaiting its claim (`catch.requested` live, demo poll) or an error.
  // Also the one-scan-at-a-time guard — the camera keeps running and
  // the Hunter can re-scan once this resolves.
  const [pendingScanToken, setPendingScanToken] = useState<string | null>(null);

  const urlRunnerId = query.runner ?? null;
  const isHost = myPlayer?.isHost ?? false;
  const isHunter = myPlayer?.matchRole === 'hunter';
  const isRunner = myPlayer?.matchRole === 'runner';
  const isSuspended = myPlayer?.connectionState === 'suspended';

  // P0-1 (demo): resume on catch-page arrival.
  useEffect(() => {
    if (mode !== 'demo' || !demo || !myPlayerId) return;
    resumePlayerOnCatchPageArrival(demo, myPlayerId);
    refreshDemo();
    // Once on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, demo?.room.roomId, myPlayerId]);

  // Room deleted (founder decision, 2026-11-21): the host cancelled
  // and the room is gone — home with the one plain message. Declared
  // before the LOBBY effect below so a deletion never routes to the
  // lobby of a dead room on the way home.
  useEffect(() => {
    if (!roomDeleted) return;
    goHomeAfterRoomDeleted(router, roomId);
  }, [roomDeleted, roomId, router]);

  // v31 fix round (F3): this page had NO self-ejected/removed
  // handling at all — an ejected or host-removed seat kept the catch
  // screen with no explanation. The mirror dies with the seat (the
  // hook's snapshot handling clears it too; this is the page-level
  // backstop, mirroring the play page's ejected effect), and the
  // banner below says so in plain words.
  const ejectedAt = myPlayer?.ejectedAt ?? null;
  const removedAt = myPlayer?.leftAt ?? null;
  useEffect(() => {
    if (ejectedAt || removedAt) clearRejoinToken(roomId);
  }, [ejectedAt, removedAt, roomId]);

  // A9 (v18 fix round): replay-reset — when the room returns to LOBBY
  // (after a replay), go back to the lobby, like the results and play
  // pages. Guarded on loading/room: the hook's initial phase IS 'LOBBY'
  // before the first snapshot lands, and that must not redirect — without
  // this, a client sitting on /catch at replay time was stranded on
  // "Catches count once the match is live." with no way forward.
  useEffect(() => {
    if (loading || !room || roomDeleted) return;
    if (phase === 'LOBBY') {
      router.replace(`/room/${roomId}`);
    }
  }, [loading, room, phase, roomDeleted, roomId, router]);

  // The open claim involving me (as Runner or as Hunter).
  const openClaim =
    activeCatches.find(
      (c) => c.runnerPlayerId === myPlayerId || c.hunterPlayerId === myPlayerId,
    ) ?? null;

  // Effective Runner (P0-2 order): URL → open claim → picker → latest confirmed → picker.
  const effectiveRunnerId = (() => {
    if (mode === 'demo' && demo) {
      return resolveEffectiveRunner(demo, myPlayerId, {
        urlRunnerId,
        pickerChoiceId: pickerChoice,
      }).runnerId;
    }
    if (urlRunnerId && players.some((p) => p.playerId === urlRunnerId)) return urlRunnerId;
    if (openClaim) return openClaim.runnerPlayerId;
    if (pickerChoice && players.some((p) => p.playerId === pickerChoice)) return pickerChoice;
    const latest = [...sessionCatches]
      .reverse()
      .find(
        (c) =>
          c.state === 'confirmed' &&
          (c.runnerPlayerId === myPlayerId || c.hunterPlayerId === myPlayerId),
      );
    return latest?.runnerPlayerId ?? null;
  })();

  const effectiveRunner = players.find((p) => p.playerId === effectiveRunnerId) ?? null;
  const latestConfirmed =
    [...sessionCatches]
      .reverse()
      .find(
        (c) =>
          c.state === 'confirmed' &&
          (c.runnerPlayerId === myPlayerId || c.hunterPlayerId === myPlayerId),
      ) ?? null;
  const doneCatch =
    (doneCatchId
      ? (sessionCatches.find((c) => c.catchId === doneCatchId) ?? null)
      : null) ?? (latestConfirmed && latestConfirmed.catchId !== dismissedDoneCatchId && !openClaim ? latestConfirmed : null);

  // v18 auto-QR — the Runner mints their own claim-less token the moment
  // the catch screen opens with no open claim (live: WS
  // `catch.runner-token`, empty payload; demo: the engine's
  // `issueRunnerQrToken` via the demo store). Every mint is fresh — a
  // re-mint is always a new commandId (live) / a fresh issue (demo), so
  // the old QR dies at once. The reply lands via `lastRunnerToken`
  // (live) or the awaited return (demo).
  const shouldMint =
    isRunner && phase === 'ACTIVE' && !openClaim && !doneCatch && !isSuspended;
  const openClaimRef = useRef(openClaim);
  openClaimRef.current = openClaim;
  const mintRunnerQr = useCallback(() => {
    if (mintInFlightRef.current) return;
    if (mode === 'live') {
      if (socketState !== 'connected') return;
      mintInFlightRef.current = true;
      setMinting(true);
      setMintFailed(null);
      pendingMintAtMsRef.current = Date.now();
      if (!socket?.requestRunnerToken()) {
        mintInFlightRef.current = false;
        setMinting(false);
        pendingMintAtMsRef.current = null;
        setMintFailed('Not connected — your QR was not sent. Wait for the reconnect, then try again.');
      }
      return;
    }
    const current = getRoom(roomId);
    if (!current) {
      setMintFailed('Game not found on this device.');
      return;
    }
    mintInFlightRef.current = true;
    setMinting(true);
    setMintFailed(null);
    void mintRunnerQrToken(current, myPlayerId)
      .then((minted) => {
        setMintedToken({ token: minted.token, expiresAt: minted.expiresAt });
        refreshDemo();
      })
      .catch((err: unknown) => {
        // An open claim raced in — the claim QR takes over (refresh so
        // it appears at once; the claim effect below clears this
        // message once the claim lands). Anything else shows the
        // server's reason, with a retry.
        if (err instanceof Error && err.message.startsWith('A Hunter has already claimed you')) {
          refreshDemo();
        }
        setMintFailed(err instanceof Error ? err.message : 'Could not show your QR.');
      })
      .finally(() => {
        mintInFlightRef.current = false;
        setMinting(false);
      });
  }, [mode, myPlayerId, refreshDemo, roomId, socket, socketState]);

  // Mint on arrival (and on re-mint after expiry) — once, when the
  // conditions first hold. Live waits for the socket to be connected;
  // a dead socket reports plainly instead of waiting forever.
  useEffect(() => {
    if (!shouldMint) return;
    if (mintedToken || mintFailed || mintInFlightRef.current) return;
    if (mode === 'live') {
      if (socketState === 'connected') {
        mintRunnerQr();
      } else if (socketState === 'reconnect-failed' || socketState === 'closed') {
        setMintFailed('Not connected — your QR was not sent. Wait for the reconnect, then try again.');
      }
      // 'connecting' / 'reconnecting' / 'idle': wait — the card says
      // "Getting your QR…" until the socket lands.
      return;
    }
    mintRunnerQr();
  }, [shouldMint, mode, socketState, mintedToken, mintFailed, mintRunnerQr]);

  // The mint reply (live): the direct `catch.runner-token` envelope —
  // the raw token, once, to the Runner only. A reply that lands after a
  // claim opened is discarded — the claim QR shows instead.
  useEffect(() => {
    if (!lastRunnerToken) return;
    if (lastRunnerToken.runnerId !== myPlayerId) return;
    pendingMintAtMsRef.current = null;
    mintInFlightRef.current = false;
    setMinting(false);
    if (openClaimRef.current) return;
    setMintFailed(null);
    setMintedToken({ token: lastRunnerToken.token, expiresAt: lastRunnerToken.expiresAt });
  }, [lastRunnerToken, myPlayerId]);

  // 1 s ticker while a minted QR is on screen — the countdown, and the
  // auto re-mint below when it hits zero.
  useEffect(() => {
    if (!mintedToken || openClaim) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [mintedToken, openClaim]);

  // The minted QR expired: drop it — the mint effect above re-mints with
  // a fresh token at once, so the Runner never sits on a dead QR.
  useEffect(() => {
    if (!mintedToken || openClaim || phase !== 'ACTIVE') return;
    if (Date.parse(mintedToken.expiresAt) - nowMs > 0) return;
    setMintedToken(null);
  }, [mintedToken, openClaim, phase, nowMs]);

  // The Runner's QR token: live fetches it (once, over HTTPS); demo reads
  // the in-memory raw token. Never stored beyond the screen. A claim
  // being open drops the minted token — the claim's QR shows, never the
  // minted one (the minted token may already be consumed by this claim),
  // so a later claim-free moment re-mints fresh.
  useEffect(() => {
    if (!openClaim || openClaim.runnerPlayerId !== myPlayerId) {
      setQrToken(null);
      return;
    }
    setMintedToken(null);
    setMintFailed(null);
    if (mode === 'demo') {
      setQrToken(getCatchRaw(openClaim.catchId));
      return;
    }
    const session = getSessionForRoom(roomId);
    if (!session?.reconnectToken) return;
    let cancelled = false;
    fetchLiveCatchToken(roomId, myPlayerId, session.reconnectToken, openClaim.catchId)
      .then((res) => {
        if (!cancelled) setQrToken(res.token);
      })
      .catch(() => {
        if (!cancelled) setQrToken(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, openClaim, myPlayerId, roomId]);

  // Picker names (name-only; live exclusions mirror the demo list).
  const pickerNames =
    mode === 'demo' && demo
      ? listCatchPickerNames(demo, myPlayerId)
      : (() => {
          const caughtIds = new Set(
            sessionCatches.filter((c) => c.state === 'confirmed').map((c) => c.runnerPlayerId),
          );
          return players
            .filter(
              (p) =>
                p.playerId !== myPlayerId &&
                p.leftAt === null &&
                p.ejectedAt === null &&
                !caughtIds.has(p.playerId),
            )
            .map((p) => ({ playerId: p.playerId, displayName: p.displayName }));
        })();

  const disputedCatches = activeCatches.filter((c) => c.state === 'disputed');

  // Self Confirm candidates (Way 2): the Hunters in this game. Demo
  // roles are visible locally, so the list is true Hunters. Live role
  // secrecy hides every other seat's role (matchRole is null for anyone
  // but me), so the live list is every active player but me by name —
  // the server rejects a non-Hunter pick (FORBIDDEN, "That player is
  // not a Hunter."). Classic excludes confirmed-caught Runners (they are
  // out and cannot be Hunters); Infection does not (a flipped Runner IS
  // a Hunter and can tag).
  const selfConfirmCandidates = (() => {
    const caughtIds = new Set(
      sessionCatches.filter((c) => c.state === 'confirmed').map((c) => c.runnerPlayerId),
    );
    return players.filter((p) => {
      if (p.playerId === myPlayerId || p.leftAt !== null || p.ejectedAt !== null) return false;
      if (mode === 'demo') return p.matchRole === 'hunter';
      if (room?.config.mode === 'classic' && caughtIds.has(p.playerId)) return false;
      return true;
    });
  })();

  // -- Hunter: claim a Runner -----------------------------------------------
  const handleClaim = () => {
    const targetId = pickerChoice ?? effectiveRunnerId;
    if (!targetId) return;
    setNotice(null);
    setManualMode(false);
    if (mode === 'live') {
      if (!socket?.requestCatch(targetId)) {
        setNotice('Not connected — the claim was not sent. Wait for the reconnect, then tap again.');
        return;
      }
      return;
    }
    const current = getRoom(roomId);
    if (!current) return;
    try {
      requestCatch(current, myPlayerId, targetId, crypto.randomUUID());
      refreshDemo();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'That player could not be claimed.');
    }
  };

  // -- Hunter: scan the Runner's QR (Way 1) ----------------------------------
  // A scan never confirms on its own — it holds the token until the
  // Hunter taps Tag. Live the scan goes to the server (`catch.request`
  // with the raw token, no runnerId): the server resolves the Runner
  // from the token and creates the claim, which lands as
  // `catch.requested` — the effect below then arms the Tag button with
  // the held token. A failed scan arrives as an error envelope (see the
  // effect on lastSocketError) and does NOT consume the token, so the
  // Hunter can retry with the same QR. Demo resolves the token the same
  // way (engine `resolveRunnerQrToken` via the demo store).
  const handleScan = (rawToken: string) => {
    // One scan at a time: a decode that lands while a scan is in flight
    // is ignored — the camera keeps running and the Hunter can re-scan
    // once the first one resolves (the loop re-reports after 3 s).
    if (pendingScanToken) return;
    if (mode === 'live') {
      if (!socket?.requestCatchByToken(rawToken)) {
        setNotice('Not connected — the QR was not sent. Wait for the reconnect, then scan again.');
        return;
      }
      setPendingScanToken(rawToken);
      pendingScanAtMsRef.current = Date.now();
      setNotice('Checking the QR…');
      return;
    }
    const current = getRoom(roomId);
    if (!current) {
      setNotice('Game not found on this device.');
      return;
    }
    setPendingScanToken(rawToken);
    void scanRunnerQrToken(current, myPlayerId, rawToken)
      .then(() => {
        // The claim lands on the next demo poll; the effect below arms
        // the Tag button with the held token once it does.
        refreshDemo();
      })
      .catch((err: unknown) => {
        setPendingScanToken(null);
        setNotice(
          err instanceof Error ? err.message : "That QR didn't match — scan the Runner's QR again.",
        );
      });
  };

  // A scan's claim landed: arm the Tag button with the held token. The
  // claim is the one the scan created (or bound to, on a same-Hunter
  // re-request) — the Hunter taps Tag to confirm it.
  useEffect(() => {
    if (!pendingScanToken) return;
    if (!openClaim || openClaim.hunterPlayerId !== myPlayerId) return;
    const runnerName =
      players.find((p) => p.playerId === openClaim.runnerPlayerId)?.displayName ?? 'the Runner';
    setScannedToken(pendingScanToken);
    setPendingScanToken(null);
    setNotice(`QR scanned — tap Tag to confirm ${runnerName}.`);
  }, [pendingScanToken, openClaim, myPlayerId, players]);

  // -- Hunter: Tag — confirm the scanned Runner (Way 1) ----------------------
  const handleTag = () => {
    const targetId = openClaim?.runnerPlayerId ?? pickerChoice ?? effectiveRunnerId;
    if (!targetId) {
      setNotice('Pick a Runner below first.');
      return;
    }
    if (!scannedToken) {
      setNotice("Scan the Runner's QR first — point the camera at their QR.");
      return;
    }
    const token = scannedToken;
    setNotice(null);
    if (mode === 'live') {
      const claim =
        activeCatches.find(
          (c) =>
            c.hunterPlayerId === myPlayerId &&
            c.runnerPlayerId === targetId &&
            (c.state === 'requested' || c.state === 'awaiting-confirmation'),
        ) ?? null;
      if (claim) {
        if (!socket?.sendCatchConfirm(claim.catchId, token)) {
          setNotice('Not connected — the tag was not sent. Try again.');
          return;
        }
        // A server rejection arrives only as an error envelope — the
        // effect on lastSocketError below shows the server's reason.
        pendingScanAtMsRef.current = Date.now();
        return;
      }
      // No claim yet: claim first, then confirm with the held token the
      // moment the claim lands (see the effect below).
      if (!socket?.requestCatch(targetId)) {
        setNotice('Not connected — the claim was not sent. Wait for the reconnect, then tap again.');
        return;
      }
      tagTargetRef.current = targetId;
      setTagAfterClaim(true);
      setNotice('Claim sent — confirming once the claim lands…');
      return;
    }
    const current = getRoom(roomId);
    if (!current) return;
    try {
      let claim =
        current.catches.find(
          (c) =>
            c.hunterPlayerId === myPlayerId &&
            c.runnerPlayerId === targetId &&
            (c.state === 'requested' || c.state === 'awaiting-confirmation'),
        ) ?? null;
      if (!claim) {
        claim = requestCatch(current, myPlayerId, targetId, crypto.randomUUID()).catch;
        refreshDemo();
      }
      // No client-side wrong-scan lockout: the WS `catch.confirm`
      // 5/min/seat rate limit already bounds failed confirms. A wrong
      // scan just says so and the scanner keeps running — re-scan in
      // place (P1-28).
      if (!verifyCatchScan(claim.catchId, token)) {
        setNotice("That QR didn't match — try again.");
        return;
      }
      const confirmed = confirmCatch(current, claim.catchId, myPlayerId, 'qr-scan');
      setDoneCatchId(confirmed.catchId);
      setDismissedDoneCatchId(null);
      setScannedToken(null);
      setTagAfterClaim(false);
      refreshDemo();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not confirm the tag.');
    }
  };

  // Live only: Tag was tapped before a claim existed — confirm with the
  // held token the moment the matching claim lands. The flag clears
  // before sending, so a re-render never double-confirms.
  useEffect(() => {
    if (mode !== 'live' || !tagAfterClaim || !scannedToken) return;
    if (
      !openClaim ||
      openClaim.hunterPlayerId !== myPlayerId ||
      openClaim.runnerPlayerId !== tagTargetRef.current
    ) {
      return;
    }
    setTagAfterClaim(false);
    if (!socket?.sendCatchConfirm(openClaim.catchId, scannedToken)) {
      setNotice('Not connected — the tag was not sent. Try again.');
      return;
    }
    pendingScanAtMsRef.current = Date.now();
  }, [mode, tagAfterClaim, scannedToken, openClaim, socket, myPlayerId]);

  // -- Runner: Self confirm (Way 2) -------------------------------------------
  // NO dispute button here on purpose (founder decision, 2026-11-19):
  // the Runner confirms with Self confirm; there is no "NO — DISPUTE"
  // action in the client. The server-side dispute handler stays
  // intentionally dormant — a disputed catch can still only arrive via
  // the host's resolve path, never from this screen.
  //
  // Self confirm needs NO open claim and NO Hunter confirmation: the
  // Runner picks the Hunter who tagged them in the sheet and taps OK.
  // Live sends `catch.self-confirm` { hunterId }; demo calls
  // `selfConfirmCatch` (creates the claim + confirms it atomically).
  const handleSelfConfirmOpen = () => {
    if (isSuspended) {
      setNotice("You're suspended — reconnect to confirm.");
      return;
    }
    if (selfConfirmCandidates.length === 0) {
      setNotice('No Hunters in this game yet.');
      return;
    }
    setNotice(null);
    setSelfConfirmHunterId(
      openClaim &&
        selfConfirmCandidates.some((p) => p.playerId === openClaim.hunterPlayerId)
        ? openClaim.hunterPlayerId
        : null,
    );
    setSelfConfirmOpen(true);
  };

  const handleSelfConfirmOk = () => {
    const hunterId = selfConfirmHunterId;
    if (!hunterId) return;
    setSelfConfirmOpen(false);
    if (isSuspended) {
      setNotice("You're suspended — reconnect to confirm.");
      return;
    }
    if (confirming) return;
    setConfirming(true);
    setNotice(null);
    if (mode === 'live') {
      if (!socket?.sendCatchSelfConfirm(hunterId)) {
        setConfirming(false);
        setNotice('Not connected — the confirmation was not sent. Wait for the reconnect, then tap again.');
        return;
      }
      // Confirmed state arrives over the socket; the done card renders from it.
      // A server rejection arrives only as an error envelope (the effect
      // on lastSocketError below clears this and shows the reason); the
      // 10 s timeout is the fallback if no envelope ever arrives, so a
      // Runner can never wedge on "Confirming…" with a disabled button.
      clearConfirmTimeout();
      pendingConfirmAtMsRef.current = Date.now();
      confirmTimeoutRef.current = setTimeout(() => {
        confirmTimeoutRef.current = null;
        pendingConfirmAtMsRef.current = null;
        setConfirming(false);
        setNotice('Confirmation timed out — the server did not answer. Tap Self confirm again.');
      }, 10_000);
      return;
    }
    const current = getRoom(roomId);
    if (!current) {
      setConfirming(false);
      return;
    }
    try {
      const confirmed = selfConfirmCatch(current, myPlayerId, hunterId);
      setDoneCatchId(confirmed.catchId);
      setDismissedDoneCatchId(null);
      refreshDemo();
    } catch (err) {
      setConfirming(false);
      setNotice(err instanceof Error ? err.message : 'Could not confirm the tag.');
    }
  };

  // The pending state clears the moment the done card can render (the
  // server echo / store write landed) or the claim goes away.
  useEffect(() => {
    if (confirming && (doneCatch || !openClaim)) {
      clearConfirmTimeout();
      setConfirming(false);
    }
    // A decided catch answers any pending scan too — a later error is
    // unrelated to it.
    if (doneCatch) pendingScanAtMsRef.current = null;
  }, [confirming, doneCatch, openClaim]);

  // (b) A server rejection of the pending confirm/scan/mint arrives only
  // as an error envelope: clear the pending state and show the server's
  // reason. Tied to the pending action by receipt time (within 15 s of
  // the send) so an unrelated error never surfaces as a catch failure.
  useEffect(() => {
    if (!lastSocketError) return;
    const { atMs, message, code } = lastSocketError;
    const mintAt = pendingMintAtMsRef.current;
    if (mintAt !== null && atMs >= mintAt && atMs - mintAt < 15_000) {
      pendingMintAtMsRef.current = null;
      mintInFlightRef.current = false;
      setMinting(false);
      // CONFLICT means a claim raced in — the claim QR takes over: pull
      // a fresh snapshot so it appears at once. Either way the server's
      // reason shows (the claim effect clears it once the claim lands).
      if (code === 'CONFLICT') socket?.requestSnapshot();
      setMintFailed(message);
      return;
    }
    const confirmAt = pendingConfirmAtMsRef.current;
    if (confirmAt !== null && atMs >= confirmAt && atMs - confirmAt < 15_000) {
      clearConfirmTimeout();
      setConfirming(false);
      setNotice(message);
      return;
    }
    const scanAt = pendingScanAtMsRef.current;
    if (scanAt !== null && atMs >= scanAt && atMs - scanAt < 15_000) {
      pendingScanAtMsRef.current = null;
      setPendingScanToken(null);
      setNotice(message);
    }
  }, [lastSocketError, socket]);

  // Never leave the confirm timeout running after unmount.
  useEffect(
    () => () => {
      if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current);
    },
    [],
  );

  // -- Host: resolve a disputed catch ------------------------------------------
  const handleHostResolve = async (catchId: string, decision: 'confirmed' | 'rejected') => {
    setHostNote(null);
    if (mode === 'live') {
      try {
        await resolveLiveCatch(roomId, catchId, decision);
        setHostNote(decision === 'confirmed' ? 'Tag allowed.' : 'Tag rejected by the host.');
      } catch {
        setHostNote('Could not resolve the tag — try again.');
      }
      return;
    }
    const current = getRoom(roomId);
    if (!current) return;
    if (decision === 'rejected') {
      try {
        rejectCatch(current, catchId, myPlayerId);
        setHostNote('Tag rejected by the host.');
        refreshDemo();
      } catch (err) {
        setHostNote(err instanceof Error ? err.message : 'Could not resolve the tag.');
      }
      return;
    }
    try {
      confirmCatch(current, catchId, myPlayerId, 'host-review');
      setHostNote('Tag allowed.');
      refreshDemo();
    } catch (err) {
      setHostNote(err instanceof Error ? err.message : 'Could not resolve the tag.');
    }
  };

  if (loading) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-3 px-4 pt-3">
        <p className="py-10 text-center text-[15px] text-[#A1A1AA]">Loading catch…</p>
      </main>
    );
  }
  // v31 fix round (F3): my seat was removed — the state fetch refused
  // it with 403 `SEAT_REMOVED` (or a snapshot landed with `leftAt`
  // set). No Retry: a removed seat can never reload, and the mirror
  // is already dead — home, to join a new game.
  if (seatRemoved) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-3 px-4 pt-3">
        <p className="py-6 text-center text-[15px] font-semibold text-white">
          You were removed from the game.
        </p>
        <p className="text-center text-[14px] text-[#A1A1AA]">
          The host removed you from this game. The game goes on without you — you can join a
          new game from home.
        </p>
        <Button variant="primary" onClick={() => router.push('/')}>
          Go home
        </Button>
      </main>
    );
  }
  if (error || !room) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-3 px-4 pt-3">
        <p className="py-6 text-center text-[15px] text-white">
          {error ?? 'No live seat saved on this device for this room.'}
        </p>
        {/* A transient first-paint GET failure must not dead-end the
            screen — Retry re-requests the snapshot (P1-23). */}
        <Button variant="primary" onClick={retryConnection}>
          Retry
        </Button>
        <Button variant="outline" onClick={() => router.push('/')}>
          Go home
        </Button>
      </main>
    );
  }

  const hunterName =
    openClaim
      ? (players.find((p) => p.playerId === openClaim.hunterPlayerId)?.displayName ?? 'The Hunter')
      : null;

  // The Hunter who tagged me (confirmed catch). Only in Classic is a
  // tagged Runner OUT — in Infection they flip to Hunter and keep playing,
  // so the after-tagged screen is Classic-only.
  const doneHunterName = doneCatch
    ? (players.find((p) => p.playerId === doneCatch.hunterPlayerId)?.displayName ?? 'the Hunter')
    : null;
  const isMyConfirmedTag =
    doneCatch !== null &&
    doneCatch.runnerPlayerId === myPlayerId &&
    room?.config.mode === 'classic';

  // Hunter column: the Runner a scan/claim is about, if any.
  const claimRunnerName = effectiveRunner?.displayName ?? 'The Runner';

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col gap-4 px-4 pb-8 pt-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => router.push(`/room/${roomId}/play`)}
          className="text-[15px] font-semibold text-[#EF4444]"
        >
          ‹ Back to the map
        </button>
        <p className="pakdam-label">Room {room.roomCode}</p>
      </div>

      <h1 className="text-[28px] font-bold leading-tight text-white">Catch</h1>

      {notice ? (
        <p className="rounded-2xl border border-[#26262B] bg-[#141416] p-3 text-[14px] text-[#EF4444]">
          {notice}
        </p>
      ) : null}

      {/* v31 fix round (F3): ejected or host-removed while this tab
          was away — the seat is gone; the game goes on without you. */}
      {ejectedAt ? (
        <div className="rounded-2xl border border-[#26262B] bg-[#141416] p-3" role="status">
          <p className="text-[14px] font-semibold text-white">You were removed from the game.</p>
          <p className="mt-1 text-[13px] text-[#A1A1AA]">
            You were away too long or your location stopped updating. The game goes on without
            you — you can watch the results when the round ends, or join a new game.
          </p>
        </div>
      ) : null}
      {removedAt ? (
        <div className="rounded-2xl border border-[#26262B] bg-[#141416] p-3" role="status">
          <p className="text-[14px] font-semibold text-white">You were removed from the game.</p>
          <p className="mt-1 text-[13px] text-[#A1A1AA]">
            The host removed you from this game. The game goes on without you — you can watch
            the results when the round ends, or join a new game.
          </p>
        </div>
      ) : null}

      {phase === 'COMPLETED' || phase === 'CANCELLED' || phase === 'ABANDONED' || phase === 'EXPIRED' ? (
        <>
          <p className="text-[15px] text-white">Match over — see the results page.</p>
          <Button variant="primary" onClick={() => router.push(`/room/${roomId}/results`)}>
            See results
          </Button>
        </>
      ) : phase !== 'ACTIVE' ? (
        <p className="text-[15px] text-[#A1A1AA]">
          Catches count once the match is live.
        </p>
      ) : doneCatch && isMyConfirmedTag ? (
        // After-tagged (Classic Runner, out): "You were tagged by X" with
        // Spectate match / Back to home. The claim/QR screen never shows
        // again for this catch — it is decided, and a second confirm is
        // rejected server-side (CONFLICT).
        <div className="flex flex-col gap-3 rounded-2xl border border-[#EF4444] bg-[#141416] p-5 text-center">
          <p className="text-[28px] font-bold text-white">You were tagged</p>
          <p className="text-[15px] text-[#A1A1AA]">
            You were tagged by {doneHunterName}.
          </p>
          {room.endsAt ? (
            <p className="text-[14px] text-[#A1A1AA]">
              Time left in the round:{' '}
              {formatClock(Math.max(0, Date.parse(room.endsAt) - Date.now()))}
            </p>
          ) : null}
          <Button variant="primary" onClick={() => router.push(`/room/${roomId}/play?spectate=1`)}>
            Spectate match
          </Button>
          <button
            type="button"
            onClick={() => router.push('/')}
            className="self-center text-[15px] font-semibold text-[#EF4444]"
          >
            Back to home
          </button>
        </div>
      ) : doneCatch ? (
        // ✓ Catch confirmed — survives the claim leaving the pending set.
        // Hunter keeps this card (and the Infection flip keeps playing).
        <div className="flex flex-col gap-3 rounded-2xl border border-[#22C55E] bg-[#141416] p-5 text-center">
          <p className="text-[28px] font-bold text-white">✓ Catch confirmed</p>
          <p className="text-[15px] text-[#A1A1AA]">
            {players.find((p) => p.playerId === doneCatch.runnerPlayerId)?.displayName ?? 'The Runner'}{' '}
            was tagged by{' '}
            {players.find((p) => p.playerId === doneCatch.hunterPlayerId)?.displayName ?? 'the Hunter'}.
          </p>
          <Button variant="primary" onClick={() => router.push(`/room/${roomId}/play`)}>
            Back to the map
          </Button>
          {isHunter ? (
            <button
              type="button"
              onClick={() => {
                setDoneCatchId(null);
                setDismissedDoneCatchId(doneCatch.catchId);
                setPickerChoice(null);
                setScannedToken(null);
                setPendingScanToken(null);
                setTagAfterClaim(false);
                setManualMode(false);
              }}
              className="self-center text-[15px] font-semibold text-[#EF4444]"
            >
              Tag someone else
            </button>
          ) : null}
        </div>
      ) : isRunner ? (
        // Runner side (P1-20, v18 Way 1 + Way 2): "Got Tagged" opens the
        // Runner's own QR directly — it mints AUTOMATICALLY the moment
        // this screen opens with no claim (no "SHOW MY QR" tap ever)
        // and refreshes itself every 120 s; with an open claim the
        // claim's QR shows instead (HTTP /catch-token, unchanged).
        // BELOW the QR sits Self confirm: pick the Hunter who tagged
        // you + OK completes the tag with no Hunter confirmation and no
        // QR at all. No dispute button — founder decision, see
        // handleSelfConfirmOk.
        <div className="flex flex-col gap-4">
          {openClaim ? (
            <p className="text-[15px] text-white">
              You were tagged by {hunterName}?
            </p>
          ) : (
            <p className="text-[15px] text-white">
              Show this to the hunter — they&apos;ll scan it to claim the tag.
            </p>
          )}
          {openClaim ? (
            <ErrorBoundary kind="catch" roomId={roomId} playerId={myPlayerId}>
              <CatchQR
                mode="show"
                token={qrToken}
                runnerName={myPlayer?.displayName ?? 'You'}
                onScan={() => undefined}
                onManualFallback={() => undefined}
              />
              {errorBoundaryTestCatch ? <ErrorBoundaryThrowTest /> : null}
            </ErrorBoundary>
          ) : mintedToken ? (
            // The minted QR + its countdown — it refreshes itself on
            // expiry (new token, old QR dead at once). The raw token is
            // a QR only, never text.
            <div className="flex flex-col gap-3">
              <ErrorBoundary kind="catch" roomId={roomId} playerId={myPlayerId}>
                <CatchQR
                  mode="show"
                  token={mintedToken.token}
                  runnerName={myPlayer?.displayName ?? 'You'}
                  onScan={() => undefined}
                  onManualFallback={() => undefined}
                />
              </ErrorBoundary>
              <p className="text-center text-[14px] text-[#A1A1AA]">
                QR refreshes in {formatClock(Math.max(0, Date.parse(mintedToken.expiresAt) - nowMs))}
              </p>
            </div>
          ) : mintFailed ? (
            // A failed mint shows the server's reason in plain words —
            // never a blank screen, never a generic error.
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#26262B] bg-[#141416] p-6 text-center">
              <p className="text-[15px] font-bold text-white">{myPlayer?.displayName ?? 'You'}</p>
              <p className="text-[14px] text-[#EF4444]">{mintFailed}</p>
              <button
                type="button"
                onClick={() => {
                  setMintFailed(null);
                  mintRunnerQr();
                }}
                className="self-center text-[15px] font-semibold text-[#EF4444]"
              >
                Try again
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#26262B] bg-[#141416] p-6 text-center">
              <p className="text-[15px] font-bold text-white">{myPlayer?.displayName ?? 'You'}</p>
              <p className="text-[14px] text-[#A1A1AA]">
                {minting ? 'Getting your QR…' : 'Waiting for connection…'}
              </p>
            </div>
          )}
          {isSuspended ? (
            <p className="rounded-2xl border border-[#F59E0B] bg-[#141416] p-3 text-[14px] text-white">
              You&apos;re suspended — reconnect to confirm.
            </p>
          ) : null}
          <button
            type="button"
            onClick={handleSelfConfirmOpen}
            disabled={isSuspended || confirming}
            className="self-center text-[15px] font-semibold text-[#EF4444] disabled:opacity-40"
          >
            {confirming ? 'Confirming…' : 'Self confirm'}
          </button>
        </div>
      ) : isHunter ? (
        // Hunter side (v18 Way 1): the CAMERA runs at the top (scanning
        // view) and BELOW it a small column. Scan the Runner's QR — the
        // scanned Runner appears in the column with a Tag button; Tag
        // confirms the tag. The name picker lives in that same column as
        // the manual fallback when the camera/scan cannot be used (or no
        // Runner is claimed yet): pick a name → claim → the Runner
        // confirms on their phone, no QR needed.
        <div className="flex flex-col gap-3">
          {openClaim ? (
            <p className="text-[15px] text-white">
              {claimRunnerName} · Tag them?
            </p>
          ) : (
            <p className="text-[15px] text-white">Scan a Runner&apos;s QR</p>
          )}
          <ErrorBoundary kind="catch" roomId={roomId} playerId={myPlayerId}>
            <CatchQR
              mode="scan"
              token={null}
              runnerName={claimRunnerName}
              onScan={handleScan}
              onManualFallback={() => setManualMode(true)}
            />
          </ErrorBoundary>
          {manualMode || !openClaim ? (
            // Column: manual fallback / picker. `?scan=1` with no open
            // claim lands here too (never a dead end).
            <div className="flex flex-col gap-3">
              <p className="text-[15px] text-white">Who did you tag?</p>
              <ClaimPicker
                names={pickerNames}
                selectedId={pickerChoice ?? effectiveRunnerId}
                onPick={(id) => {
                  setPickerChoice(id);
                }}
                onAction={handleClaim}
              />
              {manualMode && openClaim ? (
                <button
                  type="button"
                  onClick={() => setManualMode(false)}
                  className="self-center text-[15px] font-semibold text-[#A1A1AA]"
                >
                  Back to the claim
                </button>
              ) : null}
            </div>
          ) : (
            // Column: the claimed Runner, with Tag (enabled once their
            // QR has been scanned). Without a scan the Runner confirms
            // on their phone instead.
            <div className="flex flex-col gap-3 rounded-2xl border border-[#26262B] bg-[#141416] p-4">
              <p className="text-[15px] font-bold text-white">
                Claim open — {claimRunnerName}
              </p>
              {scannedToken ? (
                <p className="text-[14px] text-[#22C55E]">QR scanned — ready to tag.</p>
              ) : (
                <p className="text-[14px] text-[#A1A1AA]">
                  The Runner confirms on their phone — no QR needed.
                </p>
              )}
              <Button
                variant="primary"
                onClick={handleTag}
                disabled={!scannedToken}
              >
                {scannedToken ? `Tag ${claimRunnerName}` : 'Scan their QR first'}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setPickerChoice(null);
                  setScannedToken(null);
                  setPendingScanToken(null);
                  setTagAfterClaim(false);
                  tagTargetRef.current = null;
                }}
                className="self-center text-[15px] font-semibold text-[#A1A1AA]"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      ) : (
        <p className="rounded-2xl border border-[#26262B] bg-[#141416] p-4 text-[15px] text-[#A1A1AA]">
          Nothing to catch right now.
        </p>
      )}

      {/* Host: resolve disputed catches. Decision is final. */}
      {isHost && disputedCatches.length > 0 ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-[#26262B] bg-[#141416] p-4">
          <h2 className="text-[18px] font-bold text-white">Disputes</h2>
          {disputedCatches.map((c) => {
            const hunter = players.find((p) => p.playerId === c.hunterPlayerId)?.displayName ?? 'The Hunter';
            const runner = players.find((p) => p.playerId === c.runnerPlayerId)?.displayName ?? 'the Runner';
            return (
              <div key={c.catchId} className="flex flex-col gap-2 border-t border-[#26262B] pt-3 first:border-t-0 first:pt-0">
                <p className="text-[15px] text-white">
                  Dispute: {hunter} says they tagged {runner}
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleHostResolve(c.catchId, 'confirmed')}
                    className="h-12 flex-1 rounded-[14px] bg-[#EF4444] px-4 text-[15px] font-bold text-white"
                  >
                    ALLOW TAG
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleHostResolve(c.catchId, 'rejected')}
                    className="h-12 flex-1 rounded-[14px] border border-[#26262B] bg-transparent px-4 text-[15px] font-bold text-white"
                  >
                    REJECT TAG
                  </button>
                </div>
              </div>
            );
          })}
          {hostNote ? <p className="text-[14px] text-[#A1A1AA]">{hostNote}</p> : null}
        </div>
      ) : null}

      {/* Self Confirm sheet (Way 2): pick the Hunter who tagged you, then OK. */}
      <Sheet open={selfConfirmOpen} onClose={() => setSelfConfirmOpen(false)} title="Who tagged you?">
        <div className="flex flex-col gap-3">
          <p className="text-[14px] text-[#A1A1AA]">
            Pick the Hunter who tagged you, then tap OK. No confirmation is needed from them.
          </p>
          <div className="flex flex-col gap-2">
            {selfConfirmCandidates.map((entry) => {
              const isSelected = entry.playerId === selfConfirmHunterId;
              return (
                <button
                  key={entry.playerId}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => setSelfConfirmHunterId(entry.playerId)}
                  className={`flex min-h-[56px] items-center justify-between rounded-2xl border px-4 text-left text-[17px] font-bold ${
                    isSelected
                      ? 'border-[#EF4444] bg-[rgba(239,68,68,0.15)] text-white'
                      : 'border-[#26262B] bg-[#141416] text-white'
                  }`}
                >
                  <span>{entry.displayName}</span>
                  {isSelected ? <span aria-hidden className="text-[#EF4444]">✓</span> : null}
                </button>
              );
            })}
          </div>
          <Button
            variant="primary"
            onClick={handleSelfConfirmOk}
            disabled={!selfConfirmHunterId}
          >
            OK
          </Button>
        </div>
      </Sheet>
    </main>
  );
}
