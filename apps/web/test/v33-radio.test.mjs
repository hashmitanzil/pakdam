/**
 * v33 FIX 6 + voice re-enable — radio wiring and the join-nonce
 * defect (Arjun, QA).
 *
 * FIX 6 (radio wiring): PTT press → signal → ontrack → a hidden
 * `<audio>`-equivalent playback wiring per connected teammate with
 * `play()` attempted; blocked playback surfaces the enable-sound
 * prompt. v30 already built this wiring; this file pins the full
 * chain end to end — including the ANSWERER side (offer → answer →
 * ontrack → audio), which v30 never tested — plus the 1v1 team-only
 * caveat. Headless cannot hear audio: these tests pin the wiring
 * (elements, srcObject, play() calls, blocked flags), not audibility.
 *
 * VOICE RE-ENABLE (Diya's BROKEN finding, voice-radio.ts:326-331):
 * after `disable()` → `enable()`, the peer must NOT drop the
 * re-`join` as a duplicate — the join nonce must be unique per
 * attempt, and voice must reconnect WITHOUT a page reload. The
 * defect, code-proven: `handleSignal` dedupes on
 * `${from}:${kind}:${sdp?.slice(0,32)}:${JSON.stringify(candidate)}`,
 * and a `join` carries NO sdp and NO candidate — so every join
 * from the same teammate has the IDENTICAL nonce (`P2:join::null`)
 * — and `disable()` never clears `handledSignals` (it clears
 * peers, audio, streams, connected/failed — but not the nonce set).
 * The first join is consumed, the re-join after re-enable is
 * dropped as a duplicate, no offer is ever sent, and voice stays
 * dead until a page reload. Pinned failing-first below, both as a
 * single-radio test and as a two-radio end-to-end (no reload).
 *
 * FAKE SDP UNIQUENESS: the v30 fake returned one DETERMINISTIC sdp
 * for every offer/answer, which would make OFFER nonces collide
 * across attempts too and conflate the join defect with an offer
 * defect. Real SDPs are unique per offer (random ICE ufrag), so
 * this file's fake mints a fresh sdp per createOffer/createAnswer
 * call (a counter in the origin line) — the ONLY duplicate nonce
 * left in the system is the join's, which is exactly the defect.
 *
 * 1v1 CAVEAT (NSLYY3, the field game): 1 Hunter + 1 Runner are on
 * DIFFERENT teams, so `teammateIds` is empty and no radio is
 * possible BY DESIGN — "radio no sound" in that game is not a
 * defect. Pinned as a regression test.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// -- Fakes (copied from v30-radio-playback.test.mjs, self-contained;
//    the SDP counter is the ONE deliberate difference — see header). --
class FakeAudio {
  static instances = [];

  static defaultReject = false;

  constructor() {
    this.srcObject = null;
    this.muted = false;
    this.playCalls = 0;
    this.paused = false;
    this.removed = false;
    this.style = {};
    this.attrs = {};
    this.playReject = false;
    FakeAudio.instances.push(this);
  }

  setAttribute(key, value) {
    this.attrs[key] = value;
  }

  play() {
    this.playCalls += 1;
    if (FakeAudio.defaultReject || this.playReject) {
      return Promise.reject(new Error('NotAllowedError: play() failed'));
    }
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  remove() {
    this.removed = true;
  }
}

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

class FakeRTCPeerConnection {
  static instances = [];

  static sdpCounter = 0;

  constructor() {
    this.closed = false;
    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
    this.iceCandidates = [];
    FakeRTCPeerConnection.instances.push(this);
  }

  addTrack() {}

  async createOffer() {
    FakeRTCPeerConnection.sdpCounter += 1;
    return {
      type: 'offer',
      sdp: `v=0\r\no=- ${FakeRTCPeerConnection.sdpCounter} 0 IN IP4 127.0.0.1\r\n`,
    };
  }

  async createAnswer() {
    FakeRTCPeerConnection.sdpCounter += 1;
    return {
      type: 'answer',
      sdp: `v=0\r\no=- ${FakeRTCPeerConnection.sdpCounter} 0 IN IP4 127.0.0.1\r\n`,
    };
  }

  async setLocalDescription() {}

  async setRemoteDescription() {}

  async addIceCandidate(candidate) {
    this.iceCandidates.push(candidate);
  }

  close() {
    this.closed = true;
  }
}

const appended = [];
globalThis.document = {
  hidden: false,
  createElement: (tag) => (tag === 'audio' ? new FakeAudio() : { style: {}, setAttribute() {} }),
  body: {
    appendChild: (el) => {
      appended.push(el);
    },
  },
  addEventListener() {},
  removeEventListener() {},
};
globalThis.RTCPeerConnection = FakeRTCPeerConnection;
globalThis.MediaStream = FakeMediaStream;

const micTrack = new FakeTrack();
const micStream = new FakeMediaStream([micTrack]);
Object.defineProperty(globalThis, 'navigator', {
  value: {
    mediaDevices: {
      getUserMedia: async () => micStream,
    },
  },
  configurable: true,
});

const { VoiceRadio } = await import('../src/lib/voice-radio.ts');

function resetFakes() {
  FakeAudio.instances.length = 0;
  FakeAudio.defaultReject = false;
  FakeRTCPeerConnection.instances.length = 0;
  FakeRTCPeerConnection.sdpCounter = 0;
  appended.length = 0;
  micTrack.enabled = true;
  micTrack.stopped = false;
}

function makeRadio(t, { myPlayerId = 'P1', teammateIds = ['P2', 'P3'] } = {}) {
  const sent = [];
  const blockedChanges = [];
  const radio = new VoiceRadio({
    myPlayerId,
    teammateIds,
    sendSignal: (signal) => {
      sent.push(signal);
      return true;
    },
    onStatusChange: () => {},
    onPttChange: () => {},
    onTalkingChange: () => {},
    onPlaybackBlockedChange: (blocked) => blockedChanges.push(blocked),
  });
  t.after(() => {
    try {
      radio.disable();
    } catch {
      // Already disabled.
    }
  });
  return { radio, sent, blockedChanges };
}

async function enableRadio(radio) {
  assert.equal(await radio.enable(), true, 'getUserMedia stub must enable voice');
  assert.equal(radio.radioStatus, 'ready');
}

/** Drive a teammate's `join` through handleSignal; returns the created peer. */
async function joinFrom(radio, peerId) {
  const before = FakeRTCPeerConnection.instances.length;
  await radio.handleSignal({ fromPlayerId: peerId, toPlayerId: radio.myPlayerId, kind: 'join' });
  assert.equal(
    FakeRTCPeerConnection.instances.length,
    before + 1,
    `join from ${peerId} must create a peer connection`,
  );
  const pc = FakeRTCPeerConnection.instances.at(-1);
  assert.equal(typeof pc.ontrack, 'function', 'the peer must have an ontrack handler');
  return pc;
}

const elFor = (stream) => FakeAudio.instances.find((el) => el.srcObject === stream);

// -- FIX 6: the full chain (joiner + answerer sides). ----------------------
test('v33 FIX 6 (regression): enable() sends a join to every teammate', async (t) => {
  resetFakes();
  const { radio, sent } = makeRadio(t);
  await enableRadio(radio);
  assert.deepEqual(
    sent.map((s) => [s.kind, s.toPlayerId]),
    [
      ['join', 'P2'],
      ['join', 'P3'],
    ],
  );
});

test('v33 FIX 6 (regression): a teammate join creates a peer and sends an offer', async (t) => {
  resetFakes();
  const { radio, sent } = makeRadio(t);
  await enableRadio(radio);
  const pc = await joinFrom(radio, 'P2');
  assert.equal(pc.closed, false);
  const offers = sent.filter((s) => s.kind === 'offer' && s.toPlayerId === 'P2');
  assert.equal(offers.length, 1, 'the join reply must be exactly one offer');
  assert.equal(typeof offers[0].sdp, 'string');
});

test('v33 FIX 6 (NEW — answerer side): an offer is answered, and the answerer hears the offerer on ontrack', async (t) => {
  resetFakes();
  const { radio, sent } = makeRadio(t);
  await enableRadio(radio);
  // P2 offers me (I am the answerer — the side v30 never tested).
  await radio.handleSignal({
    fromPlayerId: 'P2',
    toPlayerId: 'P1',
    kind: 'offer',
    sdp: 'v=0\r\no=- 99 0 IN IP4 127.0.0.1\r\n',
  });
  const answers = sent.filter((s) => s.kind === 'answer' && s.toPlayerId === 'P2');
  assert.equal(answers.length, 1, 'an offer must be answered exactly once');
  assert.equal(typeof answers[0].sdp, 'string');
  assert.equal(FakeRTCPeerConnection.instances.length, 1, 'the answerer has one peer');
  const pc = FakeRTCPeerConnection.instances[0];
  const remoteStream = new FakeMediaStream([new FakeTrack()]);
  pc.ontrack({ streams: [remoteStream] });
  assert.equal(radio.getRemoteStream('P2'), remoteStream);
  const el = elFor(remoteStream);
  assert.ok(el, 'the answerer must get an <audio> element for the offerer');
  assert.equal(el.srcObject, remoteStream);
  assert.equal(el.playCalls, 1, 'play() must be attempted on track arrival');
});

test('v33 FIX 6 (regression): ICE candidates are delivered to the peer', async (t) => {
  resetFakes();
  const { radio } = makeRadio(t);
  await enableRadio(radio);
  const pc = await joinFrom(radio, 'P2');
  await radio.handleSignal({
    fromPlayerId: 'P2',
    toPlayerId: 'P1',
    kind: 'ice',
    candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 9 typ host' },
  });
  assert.equal(pc.iceCandidates.length, 1, 'the ICE candidate must reach addIceCandidate');
});

test('v33 FIX 6 (regression): PTT press enables the mic and retries blocked playback', async (t) => {
  resetFakes();
  const { radio } = makeRadio(t);
  await enableRadio(radio);
  FakeAudio.defaultReject = true;
  await joinFrom(radio, 'P2');
  FakeRTCPeerConnection.instances.at(-1).ontrack({ streams: [new FakeMediaStream([new FakeTrack()])] });
  // The blocked flag is set in the play() rejection handler — yield
  // one microtask so it lands before the assertion.
  await sleep(0);
  assert.equal(radio.isPlaybackBlocked, true, 'precondition: playback is blocked');
  FakeAudio.defaultReject = false;
  assert.equal(radio.startTalking(), true, 'PTT press must talk');
  assert.equal(micTrack.enabled, true, 'the mic is enabled while held');
  await sleep(10);
  assert.equal(radio.isPlaybackBlocked, false, 'the PTT gesture must unblock playback');
  radio.stopTalking();
  assert.equal(micTrack.enabled, false, 'the mic is disabled on release');
});

test('v33 FIX 6 (regression): blocked playback surfaces the enable-sound prompt in RadioStrip', () => {
  const strip = readFileSync(
    new URL('../src/components/radio/RadioStrip.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(strip.includes('setPlaybackBlockedListener'), 'the strip must subscribe to blocked state');
  assert.ok(strip.includes('Tap to enable sound'), 'the strip must show a tap-to-enable button');
  assert.ok(strip.includes('voiceRadio.unlockPlayback'), 'the button must call unlockPlayback() on the radio');
});

test('v33 FIX 6 (regression): a non-teammate never gets a peer or an audio element', async (t) => {
  resetFakes();
  const { radio, sent } = makeRadio(t, { teammateIds: ['P2'] });
  await enableRadio(radio);
  await radio.handleSignal({ fromPlayerId: 'PX', toPlayerId: 'P1', kind: 'join' });
  assert.equal(FakeRTCPeerConnection.instances.length, 0, 'no peer for a non-teammate');
  assert.equal(FakeAudio.instances.length, 0, 'no audio element for a non-teammate');
  assert.ok(sent.every((s) => s.toPlayerId !== 'PX'), 'nothing is ever signalled to PX');
});

test('v33 FIX 6 (regression — NSLYY3 1v1 caveat): with no teammates, enable() signals nothing and builds no peers', async (t) => {
  // The field game was 1 Hunter + 1 Runner — different teams, so
  // teammateIds is empty and no radio is possible BY DESIGN. "Radio
  // no sound" there is not a defect; this pins the design.
  resetFakes();
  const { radio, sent } = makeRadio(t, { teammateIds: [] });
  await enableRadio(radio);
  assert.equal(sent.length, 0, 'no teammates → no join signals');
  assert.equal(FakeRTCPeerConnection.instances.length, 0);
  assert.equal(radio.connectionSummary, 'Connected: 0 of 0 teammates.');
});

// -- Voice re-enable (Diya BROKEN): the join nonce must be unique per attempt.
test('v33 VOICE RE-ENABLE (single radio): after disable() → enable(), a re-join from the same teammate is NOT dropped as a duplicate', async (t) => {
  resetFakes();
  const { radio, sent } = makeRadio(t, { teammateIds: ['P2'] });
  await enableRadio(radio);
  await joinFrom(radio, 'P2');
  assert.equal(sent.filter((s) => s.kind === 'offer').length, 1, 'precondition: the first join is offered');

  radio.disable();
  assert.equal(radio.radioStatus, 'off');
  assert.deepEqual(radio.playbackPeerIds, []);
  await enableRadio(radio);

  // The teammate re-joins after MY re-enable (their client re-sends
  // join because my leave tore the peer down). This MUST produce a
  // second offer — today the nonce `P2:join::null` is still in
  // handledSignals from the first join, so it is dropped.
  const before = FakeRTCPeerConnection.instances.length;
  await radio.handleSignal({ fromPlayerId: 'P2', toPlayerId: 'P1', kind: 'join' });
  assert.equal(
    FakeRTCPeerConnection.instances.length,
    before + 1,
    'the re-join after re-enable must create a NEW peer connection (a dropped duplicate leaves voice dead until a page reload)',
  );
  assert.equal(
    sent.filter((s) => s.kind === 'offer').length,
    2,
    'the re-join must be answered with a second offer',
  );
});

test('v33 VOICE RE-ENABLE (LANDED contract — dedupe scoped, not deleted): a repeated join is tolerated and converges on the SAME peer', async (t) => {
  // Meera's landed fix EXEMPTS join/leave from the exactly-once
  // dedup (voice-radio.ts, v33 FIX 6): the join nonce was
  // `${from}:join::null` — identical on every join — so exempting
  // it is what unblocks re-enable. A duplicate join is harmless
  // BY CONSTRUCTION: `createOffer` uses `getOrCreatePeer`, which
  // reuses the existing peer — so the re-join re-offers on the SAME
  // connection (the glare rule in `answerOffer` converges it),
  // instead of leaking a second peer or a second audio element.
  // Offer/answer/ICE — where bursts and retries are real — stay
  // deduped (see the ICE test above).
  resetFakes();
  const { radio, sent } = makeRadio(t, { teammateIds: ['P2'] });
  await enableRadio(radio);
  await joinFrom(radio, 'P2');
  const join = { fromPlayerId: 'P2', toPlayerId: 'P1', kind: 'join' };
  await radio.handleSignal(join);
  assert.equal(
    FakeRTCPeerConnection.instances.length,
    1,
    'a duplicate join must not create a second peer connection (getOrCreatePeer reuses the live one)',
  );
  assert.equal(
    sent.filter((s) => s.kind === 'offer').length,
    2,
    'the duplicate join re-offers on the same peer (that re-offer is what converges it — it is not a leak)',
  );
  assert.equal(FakeAudio.instances.length, 0, 'no audio element before any stream exists');
});

test('v33 VOICE RE-ENABLE (two radios, no reload): A disables and re-enables, B re-joins, and voice reconnects', async (t) => {
  resetFakes();
  // Two radios wired to each other: A's sent signals are delivered
  // to B and vice versa, by hand — no page reload anywhere.
  const aSent = [];
  const bSent = [];
  const radioA = new VoiceRadio({
    myPlayerId: 'P1',
    teammateIds: ['P2'],
    sendSignal: (s) => {
      aSent.push(s);
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
      bSent.push(s);
      return true;
    },
    onStatusChange: () => {},
    onPttChange: () => {},
    onTalkingChange: () => {},
    onPlaybackBlockedChange: () => {},
  });
  t.after(() => {
    try {
      radioA.disable();
    } catch {
      // Already disabled.
    }
    try {
      radioB.disable();
    } catch {
      // Already disabled.
    }
  });
  const deliverToB = async (signal) => radioB.handleSignal(signal);
  const deliverToA = async (signal) => radioA.handleSignal(signal);

  // B enables first (already voice-enabled); A enables second.
  assert.equal(await radioB.enable(), true);
  assert.equal(await radioA.enable(), true);
  // A's join reaches B (already ready) → B offers → A answers.
  const joinA = aSent.find((s) => s.kind === 'join' && s.toPlayerId === 'P2');
  assert.ok(joinA, 'A must join B on enable');
  await deliverToB(joinA);
  const offerB = bSent.find((s) => s.kind === 'offer' && s.toPlayerId === 'P1');
  assert.ok(offerB, 'B must answer A’s join with an offer');
  await deliverToA(offerB);
  const answerA = aSent.find((s) => s.kind === 'answer' && s.toPlayerId === 'P2');
  assert.ok(answerA, 'A must answer B’s offer');
  await deliverToB(answerA);
  // Both sides hear each other.
  const pcA = FakeRTCPeerConnection.instances.find((pc) => pc === FakeRTCPeerConnection.instances[0]);
  const pcB = FakeRTCPeerConnection.instances[1];
  assert.ok(pcA && pcB, 'both sides must hold a peer connection');
  const streamToA = new FakeMediaStream([new FakeTrack()]);
  const streamToB = new FakeMediaStream([new FakeTrack()]);
  pcA.ontrack({ streams: [streamToB] });
  pcB.ontrack({ streams: [streamToA] });
  assert.equal(FakeAudio.instances.length, 2, 'both sides must have an audio element');

  // A disables (leave → B tears its peer down) and re-enables.
  const pcsBefore = FakeRTCPeerConnection.instances.length;
  radioA.disable();
  const leaveA = aSent.find((s) => s.kind === 'leave' && s.toPlayerId === 'P2');
  assert.ok(leaveA, 'disable must send leave');
  await deliverToB(leaveA);
  assert.equal(radioB.getRemoteStream('P1'), undefined, 'B must drop A’s stream on leave');
  assert.equal(await radioA.enable(), true, 're-enable must succeed without a reload');
  const rejoinA = aSent.filter((s) => s.kind === 'join' && s.toPlayerId === 'P2').at(-1);
  assert.ok(rejoinA, 're-enable must re-send join');
  await deliverToB(rejoinA);
  assert.equal(
    FakeRTCPeerConnection.instances.length,
    pcsBefore + 1,
    'B must create a NEW peer for the re-join — today the identical join nonce is dropped as a duplicate and voice never reconnects',
  );
  const reofferB = bSent.filter((s) => s.kind === 'offer' && s.toPlayerId === 'P1').at(-1);
  assert.ok(reofferB, 'B must offer again after the re-join');
});
