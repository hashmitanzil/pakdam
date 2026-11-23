/**
 * v30 radio-playback tests (Kabir) — the silent-radio defect.
 *
 * Root cause: the WebRTC connection was wired (`ontrack` stored the
 * incoming stream in `remoteStreams`) but `getRemoteStream()` had ZERO
 * callers and there was no `<audio>` element anywhere in the app — the
 * listener's phone received the voice and stayed silent.
 *
 * Fix under test (lib/voice-radio.ts + components/radio/RadioStrip.tsx):
 * one hidden `<audio>` element per connected teammate, owned by
 * VoiceRadio (so voice plays even when the radio tab is hidden);
 * `srcObject` attached on track arrival; a rejected `play()` sets
 * `playbackBlocked` (surfaced as a "Tap to enable sound" button) instead
 * of failing silent; `setMuted` mutes the elements too; peer close /
 * disable detaches them. Team-only: no element for a non-teammate.
 *
 * The send side is also pinned: the mic track is enabled only while
 * PTT is held (it was already correct — no send-side change in v30).
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

// -- Fakes -------------------------------------------------------------------

class FakeAudio {
  static instances = [];
  /** When true, every new element's play() rejects (autoplay blocked). */
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
// Node 24 exposes a getter-only global navigator — define, don't assign.
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
  appended.length = 0;
  micTrack.enabled = true;
}

function makeRadio(t, teammateIds = ['P2', 'P3']) {
  const sent = [];
  const blockedChanges = [];
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

/** Drive a teammate's `join` through handleSignal, then fire ontrack. */
async function connectPeer(radio, peerId, stream) {
  const before = FakeRTCPeerConnection.instances.length;
  await radio.handleSignal({ fromPlayerId: peerId, toPlayerId: 'P1', kind: 'join' });
  assert.equal(
    FakeRTCPeerConnection.instances.length,
    before + 1,
    `join from ${peerId} must create a peer connection`,
  );
  const pc = FakeRTCPeerConnection.instances.at(-1);
  assert.equal(typeof pc.ontrack, 'function', 'the peer must have an ontrack handler');
  pc.ontrack({ streams: [stream] });
  return pc;
}

const elFor = (stream) => FakeAudio.instances.find((el) => el.srcObject === stream);

// -- The defect: a remote stream must be attached and played -------------

test('v30: a remote stream is attached to a hidden <audio> element and played on track arrival', async (t) => {
  resetFakes();
  const { radio } = makeRadio(t);
  await enableRadio(radio);
  assert.equal(FakeAudio.instances.length, 0, 'no audio element before any stream exists');

  const remoteTrack = new FakeTrack();
  const remoteStream = new FakeMediaStream([remoteTrack]);
  await connectPeer(radio, 'P2', remoteStream);

  assert.equal(radio.getRemoteStream('P2'), remoteStream);
  assert.deepEqual(radio.playbackPeerIds, ['P2']);
  assert.equal(FakeAudio.instances.length, 1, 'exactly one element per connected teammate');
  const el = elFor(remoteStream);
  assert.ok(el, 'the element must carry the remote stream as srcObject');
  assert.equal(el.srcObject, remoteStream);
  assert.equal(el.playCalls, 1, 'play() must be called on track arrival');
  assert.equal(el.muted, false);
  assert.equal(el.style.display, 'none', 'the element must be hidden');
  assert.equal(el.attrs['aria-hidden'], 'true');
  assert.ok(appended.includes(el), 'the element must be in the DOM');
});

test('v30: no playback before a stream exists', async (t) => {
  resetFakes();
  const { radio } = makeRadio(t);
  await enableRadio(radio);
  assert.equal(radio.getRemoteStream('P2'), undefined);
  assert.deepEqual(radio.playbackPeerIds, []);
  assert.equal(FakeAudio.instances.length, 0);
  assert.equal(await radio.unlockPlayback(), true, 'unlock with no elements is a no-op success');
  assert.equal(radio.isPlaybackBlocked, false);
});

test('v30: one element per teammate; a second track for the same peer reuses its element', async (t) => {
  resetFakes();
  const { radio } = makeRadio(t);
  await enableRadio(radio);
  const streamP2 = new FakeMediaStream([new FakeTrack()]);
  const streamP3 = new FakeMediaStream([new FakeTrack()]);
  const pc2 = await connectPeer(radio, 'P2', streamP2);
  await connectPeer(radio, 'P3', streamP3);
  assert.equal(FakeAudio.instances.length, 2, 'two teammates = two elements');
  assert.deepEqual([...radio.playbackPeerIds].sort(), ['P2', 'P3']);
  assert.notEqual(elFor(streamP2), elFor(streamP3), 'teammates must not share an element');
  // A re-negotiated track for P2 replaces the stream on the SAME element.
  const streamP2b = new FakeMediaStream([new FakeTrack()]);
  const elBefore = elFor(streamP2);
  const playCallsBefore = elBefore.playCalls;
  pc2.ontrack({ streams: [streamP2b] });
  assert.equal(FakeAudio.instances.length, 2, 'no duplicate element for a second track');
  assert.equal(elFor(streamP2b), elBefore, 'the same element is re-attached');
  assert.equal(elBefore.playCalls, playCallsBefore + 1);
});

test('v30: ontrack with a track but no streams array still attaches (track wrapped in a MediaStream)', async (t) => {
  resetFakes();
  const { radio } = makeRadio(t);
  await enableRadio(radio);
  await radio.handleSignal({ fromPlayerId: 'P2', toPlayerId: 'P1', kind: 'join' });
  const pc = FakeRTCPeerConnection.instances.at(-1);
  const remoteTrack = new FakeTrack();
  pc.ontrack({ track: remoteTrack });
  assert.equal(FakeAudio.instances.length, 1, 'a bare track must still produce an element');
  const el = FakeAudio.instances[0];
  assert.ok(el.srcObject instanceof FakeMediaStream, 'the track must be wrapped in a stream');
  assert.ok(el.srcObject.getAudioTracks().includes(remoteTrack));
  assert.equal(el.playCalls, 1);
});

// -- Autoplay policy: blocked, never silent --------------------------------

test('v30: a rejected play() flags playback blocked; unlockPlayback (user gesture) clears it', async (t) => {
  resetFakes();
  const { radio, blockedChanges } = makeRadio(t);
  await enableRadio(radio);
  FakeAudio.defaultReject = true;
  const remoteStream = new FakeMediaStream([new FakeTrack()]);
  await connectPeer(radio, 'P2', remoteStream);
  assert.equal(radio.isPlaybackBlocked, true, 'a rejected play() must flag blocked');
  assert.ok(blockedChanges.includes(true), 'the blocked change must be reported');
  const el = elFor(remoteStream);
  assert.equal(el.playCalls, 1);

  // The user taps "Tap to enable sound" — now play() succeeds.
  FakeAudio.defaultReject = false;
  assert.equal(await radio.unlockPlayback(), true);
  assert.equal(radio.isPlaybackBlocked, false);
  assert.ok(blockedChanges.includes(false), 'the unblock must be reported');
  assert.ok(el.playCalls >= 2, 'unlock must retry play()');
});

test('v30: unlockPlayback still reports blocked while the browser refuses', async (t) => {
  resetFakes();
  const { radio } = makeRadio(t);
  await enableRadio(radio);
  FakeAudio.defaultReject = true;
  await connectPeer(radio, 'P2', new FakeMediaStream([new FakeTrack()]));
  assert.equal(radio.isPlaybackBlocked, true);
  assert.equal(await radio.unlockPlayback(), false, 'a still-refused play() stays blocked');
  assert.equal(radio.isPlaybackBlocked, true);
});

test('v30: a PTT press is a user gesture — startTalking retries blocked playback', async (t) => {
  resetFakes();
  const { radio } = makeRadio(t);
  await enableRadio(radio);
  FakeAudio.defaultReject = true;
  await connectPeer(radio, 'P2', new FakeMediaStream([new FakeTrack()]));
  assert.equal(radio.isPlaybackBlocked, true);
  FakeAudio.defaultReject = false;
  assert.equal(radio.startTalking(), true);
  await sleep(10); // unlockPlayback() runs async off the press
  assert.equal(radio.isPlaybackBlocked, false, 'the PTT gesture must unblock playback');
  radio.stopTalking(); // clear the 10 s burst timer
});

// -- Mute + cleanup ----------------------------------------------------------

test('v30: setMuted mutes the audio elements too (and unmutes them)', async (t) => {
  resetFakes();
  const { radio } = makeRadio(t);
  await enableRadio(radio);
  const remoteTrack = new FakeTrack();
  const remoteStream = new FakeMediaStream([remoteTrack]);
  await connectPeer(radio, 'P2', remoteStream);
  const el = elFor(remoteStream);
  radio.setMuted(true);
  assert.equal(el.muted, true, 'mute must silence the <audio> element');
  assert.equal(remoteTrack.enabled, false, 'mute still disables the remote track too');
  radio.setMuted(false);
  assert.equal(el.muted, false, 'unmute must restore the element');
  assert.equal(remoteTrack.enabled, true);
});

test('v30: peer close detaches only that teammate; disable detaches all', async (t) => {
  resetFakes();
  const { radio } = makeRadio(t);
  await enableRadio(radio);
  const streamP2 = new FakeMediaStream([new FakeTrack()]);
  const streamP3 = new FakeMediaStream([new FakeTrack()]);
  await connectPeer(radio, 'P2', streamP2);
  await connectPeer(radio, 'P3', streamP3);
  const el2 = elFor(streamP2);
  const el3 = elFor(streamP3);

  await radio.handleSignal({ fromPlayerId: 'P2', toPlayerId: 'P1', kind: 'leave' });
  assert.equal(el2.srcObject, null, 'the closed peer loses its stream');
  assert.equal(el2.paused, true, 'the closed peer element is paused');
  assert.equal(el2.removed, true, 'the closed peer element is removed from the DOM');
  assert.equal(radio.getRemoteStream('P2'), undefined);
  assert.deepEqual(radio.playbackPeerIds, ['P3'], 'the other teammate keeps playing');
  assert.equal(el3.srcObject, streamP3);
  assert.equal(el3.removed, false);

  radio.disable();
  assert.equal(el3.srcObject, null);
  assert.equal(el3.paused, true);
  assert.equal(el3.removed, true);
  assert.deepEqual(radio.playbackPeerIds, []);
  assert.equal(radio.isPlaybackBlocked, false);
});

test('v30: a non-teammate never gets a peer connection or an audio element', async (t) => {
  resetFakes();
  const { radio, sent } = makeRadio(t, ['P2']);
  await enableRadio(radio);
  await radio.handleSignal({ fromPlayerId: 'PX', toPlayerId: 'P1', kind: 'join' });
  assert.equal(FakeRTCPeerConnection.instances.length, 0, 'no peer for a non-teammate');
  assert.equal(FakeAudio.instances.length, 0, 'no audio element for a non-teammate');
  assert.equal(radio.getRemoteStream('PX'), undefined);
  assert.ok(sent.every((s) => s.toPlayerId !== 'PX'), 'nothing is ever signalled to PX');
});

// -- Send side (pinned: already correct, no v30 change) ---------------------

test('v30: send side — the mic track is enabled only while PTT is held', async (t) => {
  resetFakes();
  const { radio } = makeRadio(t);
  await enableRadio(radio);
  assert.equal(micTrack.enabled, false, 'mic is disabled after enable');
  assert.equal(radio.startTalking(), true);
  assert.equal(micTrack.enabled, true, 'mic is enabled while talking');
  assert.equal(radio.radioStatus, 'talking');
  radio.stopTalking();
  assert.equal(micTrack.enabled, false, 'mic is disabled on release');
  assert.equal(radio.radioStatus, 'ready');
});

test('v30: send side — startTalking refuses while muted and the mic stays off', async (t) => {
  resetFakes();
  const { radio } = makeRadio(t);
  await enableRadio(radio);
  radio.setMuted(true);
  assert.equal(radio.startTalking(), false);
  assert.equal(micTrack.enabled, false);
  radio.setMuted(false);
});

// -- Wiring pins ---------------------------------------------------------------

test('v30: RadioStrip subscribes to the blocked state and offers a tap-to-enable button', () => {
  const strip = readSrc('src/components/radio/RadioStrip.tsx');
  assert.ok(strip.includes('setPlaybackBlockedListener'), 'the strip must subscribe to blocked state');
  assert.ok(strip.includes('Tap to enable sound'), 'the strip must show a tap-to-enable button');
  assert.ok(strip.includes('unlockPlayback'), 'the button must call unlockPlayback()');
  assert.ok(strip.includes('voiceRadio.unlockPlayback'), 'the button must call it on the radio');
});

test('v30: voice-radio attaches srcObject on track arrival and detaches on close', () => {
  const src = readSrc('src/lib/voice-radio.ts');
  assert.ok(src.includes('attachPlayback'), 'ontrack must attach playback');
  assert.ok(src.includes('el.srcObject = stream'), 'the stream must become srcObject');
  assert.ok(src.includes('detachPlayback'), 'peer close / disable must detach');
  assert.ok(src.includes("document.createElement('audio')"), 'elements must be real <audio> elements');
  assert.ok(src.includes('el.muted = muted'), 'setMuted must mute the elements');
  assert.ok(src.includes('setPlaybackBlocked'), 'a rejected play() must flag blocked, never fail silent');
});
