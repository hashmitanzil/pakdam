/**
 * Catch — the QR catch flow (SCRAM-SPEC §9, PROTOCOL-MAP §4.7, P0-2).
 *
 * Tag → QR → runner confirms → manual fallback. NO catch code anywhere:
 * the token lives only inside the Runner's QR and is never shown or typed.
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

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRoomState } from '@/components/match/useRoomState';
import { CatchQR } from '@/components/catch/CatchQR';
import { ClaimPicker } from '@/components/catch/ClaimPicker';
import { Button } from '@/components/ui/Button';
import { fetchLiveCatchToken } from '@/lib/live-client';
import { resolveLiveCatch } from '@/lib/live-room-client';
import { getSessionForRoom } from '@/lib/session-credentials';
import { formatClock } from '@/lib/utils';
import {
  confirmCatch,
  getCatchRaw,
  getRoom,
  listCatchPickerNames,
  rejectCatch,
  requestCatch,
  resolveEffectiveRunner,
  resumePlayerOnCatchPageArrival,
  verifyCatchScan,
} from '@/lib/demo-store';

export default function CatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ roomId: string }>;
  searchParams: Promise<{ runner?: string; scan?: string }>;
}) {
  const { roomId } = use(params);
  const query = use(searchParams);
  const router = useRouter();

  const {
    mode,
    room,
    players,
    phase,
    activeCatches,
    sessionCatches,
    socket,
    demo,
    myPlayerId,
    myPlayer,
    loading,
    error,
    retryConnection,
    refreshDemo,
  } = useRoomState(roomId);

  const [pickerChoice, setPickerChoice] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(() => query.scan === '1');
  const [manualMode, setManualMode] = useState(false);
  const [qrToken, setQrToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [doneCatchId, setDoneCatchId] = useState<string | null>(null);
  // The done card falls back to the latest confirmed catch (so it survives
  // the claim leaving the pending set) — but "Tag someone else" must be
  // able to escape it, or the hunter can never tag a second runner: the
  // dismissed catch id is excluded from the fallback until a new catch
  // confirms (which re-arms the card).
  const [dismissedDoneCatchId, setDismissedDoneCatchId] = useState<string | null>(null);
  const [hostNote, setHostNote] = useState<string | null>(null);

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

  // The Runner's QR token: live fetches it (once, over HTTPS); demo reads
  // the in-memory raw token. Never stored beyond the screen.
  useEffect(() => {
    if (!openClaim || openClaim.runnerPlayerId !== myPlayerId) {
      setQrToken(null);
      return;
    }
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

  // -- Hunter: claim a Runner -----------------------------------------------
  const handleClaim = () => {
    const targetId = pickerChoice ?? effectiveRunnerId;
    if (!targetId) return;
    setNotice(null);
    if (mode === 'live') {
      if (!socket?.requestCatch(targetId)) {
        setNotice('Not connected — the claim was not sent. Wait for the reconnect, then tap again.');
        return;
      }
      setScanOpen(true);
      return;
    }
    const current = getRoom(roomId);
    if (!current) return;
    try {
      requestCatch(current, myPlayerId, targetId, crypto.randomUUID());
      refreshDemo();
      setScanOpen(true);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'That player could not be claimed.');
    }
  };

  // -- Hunter: scan the Runner's QR ------------------------------------------
  const handleScan = (rawToken: string) => {
    if (!openClaim) {
      setNotice('No open claim — pick a Runner first.');
      return;
    }
    if (mode === 'live') {
      if (!socket?.sendCatchConfirm(openClaim.catchId, rawToken)) {
        setNotice('Not connected — the scan was not sent. Try again.');
        return;
      }
      // Confirmed state arrives over the socket; the done card renders from it.
      return;
    }
    // No client-side wrong-scan lockout: the WS `catch.confirm` 5/min/seat
    // rate limit already bounds failed confirms (the old WRONG_SCAN_*
    // calibration was deleted as dead). A wrong scan just says so and the
    // scanner keeps running — re-scan in place (P1-28).
    const current = getRoom(roomId);
    if (!current) return;
    if (!verifyCatchScan(openClaim.catchId, rawToken)) {
      setNotice("That QR didn't match — try again.");
      return;
    }
    try {
      const confirmed = confirmCatch(current, openClaim.catchId, myPlayerId, 'qr-scan');
      setDoneCatchId(confirmed.catchId);
      setDismissedDoneCatchId(null);
      refreshDemo();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not confirm the tag.');
    }
  };

  // -- Runner: confirm / dispute ----------------------------------------------
  // NO dispute button here on purpose (founder decision, 2026-11-19):
  // the Runner confirms with Self confirm; there is no "NO — DISPUTE"
  // action in the client. The server-side dispute handler stays
  // intentionally dormant — a disputed catch can still only arrive via
  // the host's resolve path, never from this screen.
  const handleRunnerConfirm = () => {
    if (!openClaim) {
      setNotice('No open claim yet — ask the hunter to claim the tag first, then confirm here.');
      return;
    }
    if (isSuspended) {
      setNotice("You're suspended — reconnect to confirm.");
      return;
    }
    if (mode === 'live') {
      if (!socket?.sendCatchConfirm(openClaim.catchId, '', true)) {
        setNotice('Not connected — the confirmation was not sent. Wait for the reconnect, then tap again.');
        return;
      }
      // Confirmed state arrives over the socket; the done card renders from it.
      return;
    }
    const current = getRoom(roomId);
    if (!current) return;
    try {
      const confirmed = confirmCatch(current, openClaim.catchId, myPlayerId, 'manual-confirm');
      setDoneCatchId(confirmed.catchId);
      setDismissedDoneCatchId(null);
      refreshDemo();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not confirm the tag.');
    }
  };

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
                setScanOpen(false);
              }}
              className="self-center text-[15px] font-semibold text-[#EF4444]"
            >
              Tag someone else
            </button>
          ) : null}
        </div>
      ) : isRunner ? (
        // Runner side (P1-20): "Got Tagged" opens the runner's own QR
        // directly — claim or not, never a "No one has claimed a tag on
        // you yet" dead end. With an open claim the QR is the runner's
        // own catch token (fetched via getCatchToken) and Self confirm
        // settles the tag. With NO open claim yet, the note + Self
        // confirm still render and the QR appears here the moment the
        // hunter claims the tag (the snapshot re-renders this branch) —
        // the live catch-token endpoint mints a token per pending catch
        // only, so no token exists to show before a claim lands.
        // No dispute button — founder decision, see handleRunnerConfirm.
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
            <CatchQR
              mode="show"
              token={qrToken}
              runnerName={myPlayer?.displayName ?? 'You'}
              onScan={() => undefined}
              onManualFallback={() => undefined}
            />
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#26262B] bg-[#141416] p-6 text-center">
              <p className="text-[15px] font-bold text-white">{myPlayer?.displayName ?? 'You'}</p>
              <p className="text-[14px] text-[#A1A1AA]">
                Waiting for the hunter&apos;s claim — your QR appears here as soon as they claim the tag.
              </p>
              <button
                type="button"
                onClick={() => {
                  if (mode === 'live') socket?.requestSnapshot();
                  else refreshDemo();
                }}
                className="text-[15px] font-semibold text-[#EF4444]"
              >
                Check again
              </button>
            </div>
          )}
          {isSuspended ? (
            <p className="rounded-2xl border border-[#F59E0B] bg-[#141416] p-3 text-[14px] text-white">
              You&apos;re suspended — reconnect to confirm.
            </p>
          ) : null}
          <button
            type="button"
            onClick={handleRunnerConfirm}
            disabled={isSuspended}
            className="self-center text-[15px] font-semibold text-[#EF4444] disabled:opacity-40"
          >
            Self confirm
          </button>
        </div>
      ) : isHunter && openClaim && scanOpen && !manualMode ? (
        // Hunter side: scan the Runner's QR.
        <div className="flex flex-col gap-3">
          <p className="text-[15px] text-white">
            {effectiveRunner?.displayName ?? 'The Runner'} · Tag them?
          </p>
          <CatchQR
            mode="scan"
            token={null}
            runnerName={effectiveRunner?.displayName ?? ''}
            onScan={handleScan}
            onManualFallback={() => setManualMode(true)}
          />
          <button
            type="button"
            onClick={() => setScanOpen(false)}
            className="self-center text-[15px] font-semibold text-[#A1A1AA]"
          >
            Cancel
          </button>
        </div>
      ) : isHunter && openClaim ? (
        // Hunter side: claim open, scanner closed or manual fallback — the
        // Runner confirms on their phone; no QR needed.
        <div className="flex flex-col gap-3 rounded-2xl border border-[#26262B] bg-[#141416] p-4">
          <p className="text-[15px] font-bold text-white">
            Claim open — {effectiveRunner?.displayName ?? 'the Runner'}
          </p>
          <p className="text-[14px] text-[#A1A1AA]">
            The Runner confirms on their phone — no QR needed.
          </p>
          <Button variant="primary" onClick={() => { setManualMode(false); setScanOpen(true); }}>
            Scan their QR
          </Button>
          <button
            type="button"
            onClick={() => router.push(`/room/${roomId}/play`)}
            className="self-center text-[15px] font-semibold text-[#EF4444]"
          >
            Back to the map
          </button>
        </div>
      ) : isHunter && scanOpen && !openClaim ? (
        // ?scan=1 with no open claim: the picker is reachable from this
        // entry point (was a "Waiting for the claim…" dead end). Pick a
        // name → claim → the scanner opens.
        <div className="flex flex-col gap-3">
          <p className="text-[15px] text-white">Who did you tag?</p>
          <ClaimPicker
            names={pickerNames}
            selectedId={pickerChoice ?? effectiveRunnerId}
            onPick={(id) => {
              setPickerChoice(id);
              setManualMode(false);
            }}
            onAction={handleClaim}
          />
        </div>
      ) : isHunter ? (
        // Hunter side: pick the Runner by name (no roles, no codes).
        <div className="flex flex-col gap-3">
          <p className="text-[15px] text-white">Who did you tag?</p>
          <ClaimPicker
            names={pickerNames}
            selectedId={pickerChoice ?? effectiveRunnerId}
            onPick={(id) => {
              setPickerChoice(id);
              setManualMode(false);
            }}
            onAction={handleClaim}
          />
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
    </main>
  );
}
