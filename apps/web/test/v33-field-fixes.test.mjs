/**
 * v33 field fixes (Meera, web) — the redirected scope (Diya's review
 * + Kabir's server contract), pinned after implementation.
 *
 * FIX 1 — suspend delivery (the watch itself is NOT broken: Diya
 * verified PERMISSION_DENIED is the only path to `GPS_DENIED_NOTICE`,
 * the watch stays alive on unavailable/timeout, and "Try again" IS a
 * real restart — see v33-watch-lifecycle.test.mjs for those pins).
 * The code-proven defect is delivery: the denial's single
 * best-effort `reportSuspended` is discarded while the socket is
 * down (R12) and never re-asserted after a hello-resume
 * (`resumeOnHello` resumes unconditionally), so the (4a) alarm
 * ejects a seat whose phone location was ON. Pinned here: the
 * pure re-assert predicate.
 *
 * FIX 2 — way back + 4405 companions (Kabir's server half: ejection
 * closes the socket with NEW code 4405, reason 'You were ejected
 * from the game.', AFTER pushing a full snapshot carrying
 * `ejectedAt`; HTTP state for an ejected seat while live is 403
 * `SEAT_REMOVED` with the same code as a removed seat). Pinned here:
 * the post-close probe APPLIES a successful fetch; a 403 never flips
 * a known-ejected seat to removed (probe / first paint / retry);
 * a snapshot proving ejection UN-latches a racing removal; the
 * fresh-join buttons clear session + rejoin token before routing;
 * the results page polls LOBBY over HTTP when its socket is dead.
 *
 * FIX 3 — retry-after-repaint: after v31's best-effort repaint on a
 * failed ◎ tap, `easeTo` was never retried. Pinned here: one
 * rAF retry of the same ease, identity-guarded.
 *
 * FIX 4 — repaint triggers + stall guard + style re-sync: `resize()`
 * requests no frame; no `focus` listener; `verifyCanvasPainted`
 * checks size only; a context restore never re-ran the load
 * repaint or the overlay re-sync. Pinned here: the pure pill/retry
 * mappings for the new states + the wiring pins.
 *
 * FIX 5 — the dot is a symptom of Fix 1 (no fix → nothing to draw):
 * the display path itself has no independent defect. Pinned here:
 * the marker hides on no-fix, any validated fix draws, and the
 * chip-vs-dot source mismatch (chip = server `lastFixAt`, dot =
 * local `myFix`) is documented, not "fixed" away. Fix round
 * (Arjun): the marker effect re-positions on tab return
 * (`resizeNonce` in its deps) and a fix-in-view check (`fixInView`,
 * the point form of `zoneBboxInView`) pulls the camera back when
 * the dot drifted off screen on return — never on a fresh fix, so
 * free panning is never fought.
 *
 * FIX 6 — voice never reconnects after a toggle: the join nonce was
 * `${from}:join::null` — identical every time — and the dedup set
 * only clears past 500 entries, so a re-`join` after `disable()` was
 * dropped as a duplicate. Plus the glare: simultaneous `enable()`
 * made BOTH sides offer, and `answerOffer` threw in
 * `have-local-offer`, failing both. Pinned here behaviourally with a
 * state-tracking fake RTCPeerConnection.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readSrc(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

const playSrc = readSrc('src/app/room/[roomId]/play/page.tsx');
const resultsSrc = readSrc('src/app/room/[roomId]/results/page.tsx');
const catchSrc = readSrc('src/app/room/[roomId]/catch/page.tsx');
const hookSrc = readSrc('src/components/match/useRoomState.ts');
const socketSrc = readSrc('src/lib/websocket.ts');
const mapSrc = readSrc('src/components/hud/PlayMap.tsx');
const radioSrc = readSrc('src/lib/voice-radio.ts');

const {
  shouldReassertSuspension,
  pillTextForState,
  shouldOfferMapRetry,
  fixInView,
} = await import('../src/components/hud/play-map-logic.ts');
const { FakeMapLibreMap } = await import('./fake-map.mjs');

// -- FIX 1: the re-assert predicate ----------------------------------------

test('v33 FIX 1: re-assert fires exactly on a (re)connect while the watch is dead/denied', () => {
  const base = {
    mode: 'live',
    gpsDenied: true,
    socketState: 'connected',
    prevSocketState: 'reconnecting',
    connectionState: 'connected',
    ejectedAt: null,
  };
  assert.equal(shouldReassertSuspension(base), true);
  // No transition (already connected) — a snapshot that still reads
  // 'connected' must not re-send on every render.
  assert.equal(shouldReassertSuspension({ ...base, prevSocketState: 'connected' }), false);
  // Already suspended per the latest snapshot — nothing to re-assert.
  assert.equal(shouldReassertSuspension({ ...base, connectionState: 'suspended' }), false);
  // Ejected — the seat is gone; suspending it is meaningless.
  assert.equal(shouldReassertSuspension({ ...base, ejectedAt: '2026-11-25T10:00:00Z' }), false);
  // GPS healthy — never suspend a healthy seat.
  assert.equal(shouldReassertSuspension({ ...base, gpsDenied: false }), false);
  // Socket not connected — the queue (websocket.ts) owns this case.
  assert.equal(shouldReassertSuspension({ ...base, socketState: 'reconnecting' }), false);
  // Demo has no socket and no server suspension.
  assert.equal(shouldReassertSuspension({ ...base, mode: 'demo' }), false);
});

test('v33 FIX 1: the play page re-asserts in its own effect, gated on gpsDenied', () => {
  const chunks = playSrc.split(/useEffect\(/g);
  const reporting = chunks.filter((c) => /reportSuspended\(/.test(c));
  assert.ok(reporting.length >= 2, `expected a second reportSuspended call site (found ${reporting.length})`);
  assert.ok(
    reporting.some((c) => /shouldReassertSuspension/.test(c) && /\bgpsDenied\b/.test(c)),
    'the re-assert effect must use the predicate gated on gpsDenied',
  );
});

test('v33 FIX 1: a terminal socket close stops the GPS watch (no polling/sending after removal)', () => {
  assert.match(
    playSrc,
    /if \(socketState !== 'closed'\) return;\s*\n\s*watchHandleRef\.current\?\.stop\(\);/,
    'a stop effect must kill the watch when the socket closes terminally',
  );
});

// -- FIX 2: probe, 403 guards, unlatch --------------------------------------

test('v33 FIX 2: the post-close probe APPLIES a successful fetch instead of discarding it', () => {
  assert.match(
    hookSrc,
    /\.then\(\(fetched\) => \{[\s\S]{0,1200}?applySnapshot\(fetched\);/,
    'the probe must apply the fetched snapshot (the only truth after a 4405 close)',
  );
});

test('v33 FIX 2: a 403 never flips a known-ejected seat to removed (probe / first paint / retry)', () => {
  const guarded = hookSrc.match(/if \(ejectedAtRef\.current === null\) markSeatRemoved\(\);/g) ?? [];
  assert.equal(guarded.length, 3, `all three 403 sites must consult ejectedAtRef (found ${guarded.length})`);
  assert.match(hookSrc, /ejectedAtRef = useRef<string \| null>\(null\)/);
});

test('v33 FIX 2: a snapshot proving ejection UN-latches a racing removal', () => {
  assert.match(
    hookSrc,
    /if \(me\.ejectedAt !== null && seatRemovedRef\.current\) \{\s*\n\s*seatRemovedRef\.current = false;\s*\n\s*setSeatRemoved\(false\);/,
    'applySnapshot must unlatch seatRemoved when the snapshot carries ejectedAt',
  );
  assert.match(hookSrc, /ejectedAtRef\.current = me\.ejectedAt \?\? null;/);
});

test('v33 FIX 2: the socket carries the ejected copy for 4405 and refuses retry after it', () => {
  assert.match(socketSrc, /event\.code === 4405\s*\n\s*\? 'You were ejected from the game\.'/);
  assert.match(socketSrc, /this\.lastTerminalCloseCode === 4405/);
});

test('v33 FIX 2: fresh-join buttons clear session + rejoin token BEFORE routing to /join/{code}', () => {
  for (const [name, src] of [
    ['play', playSrc],
    ['results', resultsSrc],
    ['catch', catchSrc],
  ]) {
    assert.match(
      src,
      /const joinLobbyAgain = useCallback\(\s*\n\s*\(roomCode: string\) => \{\s*\n\s*clearSession\(roomId\);\s*\n\s*clearRejoinToken\(roomId\);\s*\n\s*router\.push\(`\/join\/\$\{roomCode\}`\);/,
      `${name}: joinLobbyAgain must clear session + rejoin token before routing (never restore)`,
    );
  }
  // The removed screens offer the way back; the non-host results
  // section offers it alongside the waiting line.
  assert.match(resultsSrc, /Join the lobby again/);
  assert.match(playSrc, /Join the lobby again/);
  assert.match(catchSrc, /Join the lobby again/);
  // The ejected banners carry the socket-independent path to results.
  assert.match(playSrc, /See results/);
  assert.match(catchSrc, /See results/);
  // The fresh-game route exists for everyone on full results.
  assert.match(resultsSrc, /START A FRESH GAME/);
});

test('v33 FIX 2: the results page polls LOBBY over HTTP when its socket is dead', () => {
  assert.match(
    resultsSrc,
    /if \(socketState !== 'closed' && socketState !== 'reconnect-failed'\) return;/,
    'the poll runs only as the dead-socket fallback, never beside a live socket',
  );
  assert.match(resultsSrc, /setInterval\(\(\) => \{[\s\S]{0,800}?fetchLiveRoomState\(roomId, session\.playerId, token\)/);
  assert.match(
    resultsSrc,
    /const token = session\.reconnectToken;/,
    'the token is captured before the interval (TS cannot carry the early-return narrowing into the closure)',
  );
  assert.match(resultsSrc, /if \(state\.phase === 'LOBBY'\) router\.replace\(`\/room\/\$\{roomId\}`\);/);
  assert.match(
    resultsSrc,
    /else if \(err instanceof LiveHttpError && err\.status === 403\) \{\s*\n\s*\/\/ Ejected \(or removed\) while live[\s\S]{0,200}?setLobbyPollBlocked\(true\);/,
    'a 403 stops the poll — an ejected seat cannot learn LOBBY this way',
  );
});

// -- FIX 3: retry-after-repaint ----------------------------------------------

test('v33 FIX 3: a failed easeTo is retried once, on the next frame, identity-guarded', () => {
  assert.match(
    mapSrc,
    /requestAnimationFrame\(\(\) => \{\s*\n\s*if \(mapRef\.current !== retryMap \|\| !mapReady\) return;/,
    'the retry must run on the next frame and only against the same map instance',
  );
  assert.match(
    mapSrc,
    /easeToCentre\(retryMap, retryBearing\);[\s\S]{0,120}?applyRecentreSuccess\(retrySource\);/,
    'a landed retry must clear the failure and set the normal fallback/stale note',
  );
  // The direct path still records the failure at once (the pill shows
  // it until the one-frame retry resolves).
  assert.match(mapSrc, /setRecentreFailed\(true\);\s*\n\s*setRecentreFailedAtMs\(Date\.now\(\)\);/);
});

// -- FIX 4: pill / retry mapping + wiring -------------------------------------

test('v33 FIX 4: the pill names a restoring style and a stalled paint loop — never "Map ready"', () => {
  const ready = (overrides = {}) =>
    pillTextForState('ready', 'ready', false, null, 0, null, false, false, null, null, false, false, null, false, false, ...Object.values(overrides));
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, false, null, null, false, false, null, false, false, true, false),
    'Map graphics restored — reloading…',
  );
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, false, null, null, false, false, null, false, false, false, true),
    'Map isn\u2019t painting — try Retry',
  );
  assert.equal(ready(), 'Map ready');
  // A lost context still outranks a restoring one.
  assert.equal(
    pillTextForState('ready', 'ready', false, null, 0, null, false, false, null, null, false, false, null, false, true, true, false),
    'Map graphics lost — try Retry',
  );
});

test('v33 FIX 4: a restoring style and a stalled loop both offer Retry', () => {
  const base = {
    mapState: 'ready',
    tileErrorCount: 0,
    fitFailed: false,
    fitPending: false,
    zeroHeight: false,
    zeroWidth: false,
    hasOtherResource: false,
    recentreFailed: false,
    contextLost: false,
  };
  assert.equal(shouldOfferMapRetry({ ...base, contextRestoring: true }), true);
  assert.equal(shouldOfferMapRetry({ ...base, paintStalled: true }), true);
  assert.equal(shouldOfferMapRetry(base), false);
});

test('v33 FIX 4: remeasure repaints (resize alone requests no frame) and a focus return remeasures', () => {
  assert.match(
    mapSrc,
    /map\.resize\(\);[\s\S]{0,200}?map\.triggerRepaint\(\);/,
    'the visibility/resize remeasure must request a frame after resizing',
  );
  assert.match(mapSrc, /window\.addEventListener\('focus', onFocus\);/);
  assert.match(mapSrc, /window\.removeEventListener\('focus', onFocus\);/);
});

test('v33 FIX 4: a style.load handler re-syncs overlays after a context restore', () => {
  assert.match(mapSrc, /map\.on\('style\.load', \(\) => \{[\s\S]{0,400}?setStyleNonce\(\(n\) => n \+ 1\);/);
  assert.match(mapSrc, /onContextRestored: \(\) => \{\s*\n\s*setContextLost\(false\);\s*\n\s*setContextRestoring\(true\);/);
  // All six overlay effects re-run on a style reload.
  for (const deps of [
    '[mapReady, zoneBoundary, styleNonce]',
    '[mapReady, pingFeatures, pings, styleNonce]',
    '[mapReady, noGoAreas, styleNonce]',
    '[mapReady, myFix, nowMs, styleNonce]',
    '[mapReady, teammateFixes, styleNonce]',
    '[mapReady, myFix, teammateFixes, nowMs, styleNonce]',
  ]) {
    assert.ok(mapSrc.includes(deps), `overlay deps must include styleNonce: ${deps}`);
  }
});

test('v33 FIX 4: a render listener feeds the stall guard, which flags a requested repaint with no later frame', () => {
  assert.match(mapSrc, /map\.on\('render', \(\) => \{\s*\n\s*lastRenderAtMsRef\.current = Date\.now\(\);/);
  assert.match(
    mapSrc,
    /if \(now - requestedAt >= 5000 && lastRenderAtMsRef\.current < requestedAt\) \{/,
    'the guard fires only when no frame followed the request within 5 s',
  );
});

// -- FIX 5: the dot path has no independent defect (pins) ----------------------

test('v33 FIX 5: any validated fix draws the dot; no fix hides it (no ±50 m display gate)', () => {
  assert.match(
    mapSrc,
    /if \(!fix \|\| !Number\.isFinite\(fix\.lat\) \|\| !Number\.isFinite\(fix\.lng\)\) \{\s*\n\s*el\.style\.display = 'none';/,
    'the marker hides only when there is no (finite) fix at all',
  );
  assert.match(
    mapSrc,
    /the ±50 m gate is a gameplay-usability gate, never a[\s\S]{0,12}?display gate, so ANY validated fix \(up to ±1000 m\) draws/,
  );
});

test('v33 FIX 5: the YOU chip reads the server lastFixAt while the dot reads the local fix (source mismatch, documented)', () => {
  assert.match(playSrc, /const myLastFixMs = myPlayer\?\.lastFixAt \? new Date\(myPlayer\.lastFixAt\)\.getTime\(\) : null;/);
  assert.match(mapSrc, /const fix = myFixRef\.current;/);
});

// -- FIX 6: voice re-enable + glare (behavioural) -----------------------------

class FakeTrack {
  constructor() {
    this.kind = 'audio';
    this.enabled = true;
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
  }
}

class FakeMediaStream {
  constructor(tracks = []) {
    this._tracks = tracks;
  }

  getAudioTracks() {
    return this._tracks;
  }

  getTracks() {
    return this._tracks;
  }
}

class FakeAudio {
  constructor() {
    this.srcObject = null;
    this.muted = false;
    this.style = {};
    this.attrs = {};
  }

  setAttribute(k, v) {
    this.attrs[k] = v;
  }

  play() {
    return Promise.resolve();
  }

  pause() {}

  remove() {}
}

/**
 * A state-tracking RTCPeerConnection: unlike the v30 fake (whose
 * setLocal/RemoteDescription are no-ops), this one models the
 * signalling states the glare rule branches on — including the real
 * browser behaviour that `setRemoteDescription({type:'offer'})`
 * THROWS while `have-local-offer`.
 */
class StatefulFakePC {
  static instances = [];

  constructor() {
    this.closed = false;
    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
    StatefulFakePC.instances.push(this);
  }

  addTrack() {}

  async createOffer() {
    return { type: 'offer', sdp: `v=0\r\no=- ${Math.random()} 0 IN IP4 127.0.0.1\r\n` };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' };
  }

  async setLocalDescription(desc) {
    if (!desc) return;
    if (desc.type === 'rollback') this.signalingState = 'stable';
    else if (desc.type === 'offer') this.signalingState = 'have-local-offer';
    else if (desc.type === 'answer') this.signalingState = 'stable';
  }

  async setRemoteDescription(desc) {
    if (desc.type === 'offer' && this.signalingState === 'have-local-offer') {
      throw new Error('InvalidStateError: cannot set remote offer in have-local-offer');
    }
    if (desc.type === 'offer') this.signalingState = 'have-remote-offer';
    else if (desc.type === 'answer' && this.signalingState === 'have-local-offer') {
      this.signalingState = 'stable';
    }
  }

  async addIceCandidate() {}

  close() {
    this.closed = true;
  }
}

globalThis.document = {
  hidden: false,
  createElement: (tag) => (tag === 'audio' ? new FakeAudio() : { style: {}, setAttribute() {} }),
  body: { appendChild: () => {} },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.RTCPeerConnection = StatefulFakePC;
globalThis.MediaStream = FakeMediaStream;
Object.defineProperty(globalThis, 'navigator', {
  value: {
    mediaDevices: {
      // A fresh stream per call — disable() stops the old tracks.
      getUserMedia: async () => new FakeMediaStream([new FakeTrack()]),
    },
  },
  configurable: true,
});

const { VoiceRadio } = await import('../src/lib/voice-radio.ts');

function makePair() {
  // Cross-wired radios with a deliverable outbox: signals sit
  // queued until the test flushes them, so simultaneity can be
  // staged (both joins queued before either is delivered).
  const outbox = [];
  const sentA = [];
  const sentB = [];
  const radioA = new VoiceRadio({
    myPlayerId: 'P1',
    teammateIds: ['P2'],
    sendSignal: (s) => {
      sentA.push(s);
      outbox.push({ to: 'B', signal: s });
      return true;
    },
    onStatusChange: () => {},
    onPttChange: () => {},
    onTalkingChange: () => {},
    onPlaybackBlockedChange: () => {},
  });
  const radioB = new VoiceRadio({
    myPlayerId: 'P2',
    teammateIds: ['P1'],
    sendSignal: (s) => {
      sentB.push(s);
      outbox.push({ to: 'A', signal: s });
      return true;
    },
    onStatusChange: () => {},
    onPttChange: () => {},
    onTalkingChange: () => {},
    onPlaybackBlockedChange: () => {},
  });
  const radios = { A: radioA, B: radioB };
  async function flush() {
    // Deliver one signal at a time, letting each async handler
    // settle (createOffer / answerOffer are awaited promises) —
    // loop until the outbox is empty (handlers enqueue replies).
    for (let round = 0; round < 20 && outbox.length > 0; round += 1) {
      const item = outbox.shift();
      await radios[item.to].handleSignal(item.signal);
      await sleep(0);
    }
    assert.equal(outbox.length, 0, 'the exchange must converge (no signal storm)');
  }
  return { radioA, radioB, sentA, sentB, flush };
}

test('v33 FIX 6: voice reconnects after a toggle — a re-join after disable() is accepted, not deduped', async (t) => {
  StatefulFakePC.instances.length = 0;
  const { radioA, radioB, sentB, flush } = makePair();
  t.after(() => {
    radioA.disable();
    radioB.disable();
  });
  assert.equal(await radioA.enable(), true);
  assert.equal(await radioB.enable(), true);
  await flush();
  const offersAfterFirstConnect = sentB.filter((s) => s.kind === 'offer').length;
  assert.equal(offersAfterFirstConnect, 1, 'first connect: B offers once');
  assert.deepEqual(radioA.failedPeers, []);
  assert.deepEqual(radioB.failedPeers, []);

  // Toggle A off and back on: B must offer AGAIN. Before the fix
  // the re-join carried the identical nonce (`P1:join::null`) and
  // was dropped as a duplicate — voice stayed dead until reload.
  radioA.disable();
  await flush();
  assert.equal(await radioA.enable(), true);
  await flush();
  assert.equal(
    sentB.filter((s) => s.kind === 'offer').length,
    offersAfterFirstConnect + 1,
    're-enable: B must offer again for the re-join (join is never deduped)',
  );
  assert.deepEqual(radioA.failedPeers, []);
  assert.deepEqual(radioB.failedPeers, []);
});

test('v33 FIX 6: simultaneous enable (glare) converges — exactly one offer survives, nobody fails', async (t) => {
  StatefulFakePC.instances.length = 0;
  const { radioA, radioB, sentA, sentB, flush } = makePair();
  t.after(() => {
    radioA.disable();
    radioB.disable();
  });
  assert.equal(await radioA.enable(), true);
  assert.equal(await radioB.enable(), true);
  // Both joins are already queued (neither delivered yet) — deliver
  // them together so both sides offer before either sees an offer.
  await flush();
  assert.equal(sentA.filter((s) => s.kind === 'offer').length, 1, 'A offers once');
  assert.equal(sentB.filter((s) => s.kind === 'offer').length, 1, 'B offers once');
  // Polite side (smaller id, P1) answers the incoming offer;
  // impolite side (P2) ignores it — exactly one answer total.
  const answers = [...sentA, ...sentB].filter((s) => s.kind === 'answer');
  assert.equal(answers.length, 1, 'glare resolves to exactly one answer (the polite side)');
  assert.equal(answers[0].fromPlayerId, 'P1', 'the smaller playerId is the polite side');
  assert.deepEqual(radioA.failedPeers, [], 'A must not end failed');
  assert.deepEqual(radioB.failedPeers, [], 'B must not end failed');
  for (const pc of StatefulFakePC.instances) {
    assert.equal(pc.signalingState, 'stable', 'every peer must settle to stable');
  }
});

test('v33 FIX 6: join/leave are exempt from the signal dedup (offer/answer/ICE still deduped)', () => {
  assert.match(
    radioSrc,
    /const deduped = signal\.kind !== 'join' && signal\.kind !== 'leave';/,
  );
});

// -- FIX ROUND (Arjun): lobby terminal routing, ejected copy, FIX 5 return. --

test('v33 FIX ROUND: lobby page routes a terminal room to results, never to play', () => {
  const lobbySrc = readSrc('src/app/room/[roomId]/page.tsx');
  assert.match(lobbySrc, /TERMINAL_PHASES/, 'the lobby page must name the terminal phases');
  assert.match(lobbySrc, /routeFromPhase/, 'a phase router must decide play vs results');
  assert.match(lobbySrc, /router\.push\(`\/room\/\$\{roomId\}\/results`\)/, 'terminal phases route to results');
  assert.match(
    lobbySrc,
    /if \(TERMINAL_PHASES\.includes\(phase\)\) goResults\(\);/,
    'terminal → results, non-terminal non-lobby → play',
  );
});

test('v33 FIX ROUND: the removed branch names the ejection for an ejected seat', () => {
  for (const [name, src] of [
    ['results', resultsSrc],
    ['play', playSrc],
    ['catch', catchSrc],
  ]) {
    assert.match(src, /You were ejected from the game\./, `${name}: the ejected copy exists`);
  }
  assert.match(
    resultsSrc,
    /myPlayer\?\.ejectedAt \? 'You were ejected from the game\.'/,
    'results: the ejected copy is gated on the pushed snapshot\'s ejectedAt',
  );
  assert.match(
    playSrc,
    /ejectedAt \? 'You were ejected from the game\.'/,
    'play: the ejected copy is gated on ejectedAt',
  );
});

test('v33 FIX 5 (fix round): the YOU marker effect re-positions on tab return — its deps include resizeNonce', () => {
  // Anchor on `positionMarker`: it is defined only inside the marker
  // effect (the first `meMarkerRef` in the file is its `useRef`
  // declaration, which belongs to no effect).
  const anchor = mapSrc.indexOf('const positionMarker');
  assert.ok(anchor >= 0, 'positionMarker must exist in PlayMap');
  const start = mapSrc.lastIndexOf('useEffect(', anchor);
  const end = mapSrc.indexOf('}, [', start);
  assert.ok(start >= 0 && end > start, 'marker effect must exist');
  const deps = mapSrc.slice(end);
  assert.match(deps, /resizeNonce/, 'the marker effect deps must include resizeNonce');
});

test('v33 FIX 5 (fix round): fixInView is the point form of zoneBboxInView', () => {
  // Zoom 13, 660×525 viewport centred on the triangle — the same
  // numbers as the zoneBboxInView pin.
  const map = new FakeMapLibreMap({ centre: [85.33, 23.35], zoom: 13 });
  assert.equal(fixInView(map, { lng: 85.33, lat: 23.35 }, 660, 525), true, 'a fix at the centre is in view');
  assert.equal(fixInView(map, { lng: 85.0, lat: 23.0 }, 660, 525), false, 'a far fix is out of view');
  assert.equal(fixInView(map, null, 660, 525), false, 'no fix is never in view');
  assert.equal(
    fixInView(map, { lng: Number.NaN, lat: 23.35 }, 660, 525),
    false,
    'a non-finite fix is never in view',
  );
});

test('v33 FIX 5 (fix round): on tab return the camera pulls an off-screen fix back — never on a fresh fix', () => {
  assert.match(
    mapSrc,
    /if \(!fixInView\(map, fix, width, height\)\) centreOn\(\);/,
    'the return effect re-centres only when the fix is out of view',
  );
  assert.match(
    mapSrc,
    /prevReturnNonceRef/,
    'the return effect fires on a resizeNonce change (tab return), not on every fix',
  );
  assert.match(
    mapSrc,
    /if \(prev === resizeNonce\) return;/,
    'the return effect is a no-op without a nonce change',
  );
});
