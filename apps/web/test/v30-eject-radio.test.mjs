/**
 * v30 eject-kills-radio tests (Meera) — Zara F2 (BROKEN in v29).
 *
 * Defect: an ejected seat kept live team voice for the rest of the
 * match. On `ejectedAt` the only effect was `clearRejoinToken`, the
 * ejected banner keeps the player on the play page with RadioStrip
 * mounted, and nothing called `voiceRadio.disable()`.
 *
 * Fix under test (play/page.tsx, client half only — the server half,
 * the DO rejecting `voice.signal` from ejected seats, is separate):
 * an effect on `[ejectedAt]` that calls `voiceRadioRef.current
 * .disable()`, nulls the ref, and `setVoiceRadio(null)`. The radio
 * cannot come back: the creation effect's `voiceRadioRef.current`
 * guard + its deps `[mode, socket, myPlayerId]` (no `ejectedAt`)
 * mean it never re-runs for the ejection.
 *
 * Deliberately NOT covered: a caught Runner turned spectator keeps
 * voice — that is a founder call, not this fix, and the effect
 * conditions on `ejectedAt` only.
 *
 * Behavioural half reuses the fake pattern of Kabir's
 * v30-radio-playback.test.mjs (FakeRTCPeerConnection / FakeAudio /
 * document / navigator.mediaDevices) — this file is self-contained
 * and does not import that test file. The page wiring itself (a React
 * effect) is covered by source pins below.
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

// -- Fakes (same pattern as v30-radio-playback.test.mjs) ---------------------

class FakeAudio {
  static instances = [];

  constructor() {
    this.srcObject = null;
    this.muted = false;
    this.paused = false;
    this.removed = false;
    this.style = {};
    this.attrs = {};
    FakeAudio.instances.push(this);
  }

  setAttribute(key, value) {
    this.attrs[key] = value;
  }

  play() {
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

  constructor() {
    this.closed = false;
    this.signalingState = 'stable';
    this.connectionState = 'new';
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
    FakeRTCPeerConnection.instances.push(this);
  }

  addTrack() {}

  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' };
  }

  async setLocalDescription() {}

  async setRemoteDescription() {}

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
globalThis.RTCPeerConnection = FakeRTCPeerConnection;
globalThis.MediaStream = FakeMediaStream;

const micTrack = new FakeTrack();
const micStream = new FakeMediaStream([micTrack]);
Object.defineProperty(globalThis, 'navigator', {
  value: { mediaDevices: { getUserMedia: async () => micStream } },
  configurable: true,
});

const { VoiceRadio } = await import('../src/lib/voice-radio.ts');

function resetFakes() {
  FakeAudio.instances.length = 0;
  FakeRTCPeerConnection.instances.length = 0;
  micTrack.enabled = true;
  micTrack.stopped = false;
}

function makeRadio(t, teammateIds = ['P2', 'P3']) {
  const sent = [];
  const radio = new VoiceRadio({
    myPlayerId: 'P1',
    teammateIds,
    sendSignal: (signal) => {
      sent.push(signal);
      return true;
    },
    onStatusChange: () => {},
    onPttChange: () => {},
    onTalkingChange: () => {},
    onPlaybackBlockedChange: () => {},
  });
  t.after(() => {
    try {
      radio.disable();
    } catch {
      // Already disabled.
    }
  });
  return { radio, sent };
}

/** Drive a teammate's `join` through handleSignal, then fire ontrack. */
async function connectPeer(radio, peerId, stream) {
  await radio.handleSignal({ fromPlayerId: peerId, toPlayerId: 'P1', kind: 'join' });
  const pc = FakeRTCPeerConnection.instances.at(-1);
  assert.equal(typeof pc.ontrack, 'function', 'the peer must have an ontrack handler');
  pc.ontrack({ streams: [stream] });
  return pc;
}

// -- The defect: disable() must end voice completely -------------------------

test('F2: disable() — what the eject effect calls — closes peers, sends leave, detaches audio, stops the mic', async (t) => {
  resetFakes();
  const { radio, sent } = makeRadio(t);
  assert.equal(await radio.enable(), true);
  assert.equal(radio.radioStatus, 'ready');

  const remoteStream = new FakeMediaStream([new FakeTrack()]);
  const pc = await connectPeer(radio, 'P2', remoteStream);
  assert.equal(pc.closed, false);
  assert.equal(radio.getRemoteStream('P2'), remoteStream, 'voice is live before the ejection');
  const audioEl = FakeAudio.instances.find((el) => el.srcObject === remoteStream);
  assert.ok(audioEl, 'a hidden <audio> element is attached to the teammate stream');

  // This is exactly what the play page's eject effect does.
  radio.disable();

  assert.equal(pc.closed, true, 'the peer connection must be closed');
  assert.equal(radio.getRemoteStream('P2'), undefined, 'no remote stream survives disable');
  assert.equal(audioEl.removed, true, 'the hidden <audio> element must be removed from the DOM');
  assert.equal(audioEl.srcObject, null, 'its srcObject must be cleared');
  assert.equal(audioEl.paused, true, 'it must be paused');
  assert.equal(micTrack.stopped, true, 'the mic track must be stopped');
  assert.equal(radio.radioStatus, 'off');
  const leaveKinds = sent.filter((s) => s.kind === 'leave').map((s) => s.toPlayerId);
  assert.deepEqual(
    [...leaveKinds].sort(),
    ['P2', 'P3'],
    'every teammate must get a leave signal so their side drops the peer too',
  );
  // Idempotent: a second disable (e.g. the creation effect's unmount
  // cleanup firing later on the same radio) must not throw.
  assert.doesNotThrow(() => radio.disable());
  assert.equal(pc.closed, true, 'the peer stays closed');
});

test('F2: disable() with no peers and no mic is a safe no-op (ejected before voice ever enabled)', async (t) => {
  resetFakes();
  const { radio, sent } = makeRadio(t);
  assert.doesNotThrow(() => radio.disable());
  assert.equal(radio.radioStatus, 'off');
  assert.deepEqual(
    sent.filter((s) => s.kind === 'leave').map((s) => s.toPlayerId).sort(),
    ['P2', 'P3'],
    'leave is still signalled to teammates even with no live peers',
  );
});

// -- Source pins: the play page's eject effect -------------------------------

const pageSrc = readFileSync(
  new URL('../src/app/room/[roomId]/play/page.tsx', import.meta.url),
  'utf8',
);

function ejectEffectSrc() {
  const start = pageSrc.indexOf('v30 (Zara F2');
  assert.ok(start > 0, 'the F2 effect comment must exist');
  const end = pageSrc.indexOf('}, [ejectedAt]);', start);
  assert.ok(end > start, 'the F2 effect must close on [ejectedAt]');
  return pageSrc.slice(start, end);
}

test('F2 pin: the eject effect disables the radio, nulls the ref, and clears state — on [ejectedAt]', () => {
  const effect = ejectEffectSrc();
  assert.ok(effect.includes('voiceRadioRef.current.disable()'), 'must call disable() on the live radio');
  assert.ok(effect.includes('voiceRadioRef.current = null'), 'must null the ref so no signal handler can reach it');
  assert.ok(effect.includes('setVoiceRadio(null)'), 'must clear state so RadioStrip/PTT get null');
  assert.ok(effect.includes('if (ejectedAt && voiceRadioRef.current)'), 'must condition on ejectedAt and a live radio');
});

test('F2 pin: the radio cannot be re-created after ejection (creation effect never re-runs on ejectedAt)', () => {
  // The creation effect guards on the ref and its deps exclude ejectedAt.
  assert.ok(
    pageSrc.includes('if (mode !== \'live\' || !socket || !myPlayerId || voiceRadioRef.current) return;'),
    'creation must refuse while a radio exists',
  );
  const creationStart = pageSrc.indexOf('Voice radio (live only)');
  const creationEnd = pageSrc.indexOf('}, [mode, socket, myPlayerId]);', creationStart);
  assert.ok(creationStart > 0 && creationEnd > creationStart, 'creation effect must close on [mode, socket, myPlayerId]');
  assert.ok(
    !pageSrc.slice(creationStart, creationEnd).includes('ejectedAt'),
    'ejectedAt must not be a creation-effect dep, or the effect would re-run and rebuild the radio',
  );
});

test('F2 pin: the eject effect sits next to the rejoin-token effect and touches no spectator logic', () => {
  const rejoinAt = pageSrc.indexOf('clearRejoinToken(roomId)');
  const f2At = pageSrc.indexOf('v30 (Zara F2');
  assert.ok(rejoinAt > 0 && f2At > rejoinAt, 'F2 must live next to the ejectedAt rejoin-token effect');
  assert.ok(f2At - rejoinAt < 2000, 'the two ejectedAt effects must be adjacent');
  const effect = ejectEffectSrc();
  assert.ok(!effect.includes('isSpectator'), 'the eject effect must not branch on spectator state');
  assert.ok(!effect.includes('amCaught'), 'the eject effect must not branch on caught state');
});
