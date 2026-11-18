// Voice radio (D-M1) — WebRTC peer-to-peer manager, tested with mock
// RTC deps (no real microphone, no real peer connection, no network).
// node:test style, so it runs under `npm run test:web`
// (scripts/test-web-lib.sh) as well as under Vitest's twin
// (vitest/voice-radio.test.ts). Run standalone from pakdam-app/ via
// the strip-types loader (see the D-M1 report) or via test-web-lib.sh.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  VoiceRadio, VOICE_MAX_BURST_MS, VOICE_STUN_URLS, isVoiceSupported,
  type VoiceMediaStream, type VoiceMediaTrack, type VoicePeerConnection, type VoiceRtcDeps, type VoiceSignalOut,
} from '../voice-radio.js';

class MockTrack implements VoiceMediaTrack {
  enabled = false;
  stopped = false;
  stop(): void { this.stopped = true; }
}
class MockStream implements VoiceMediaStream {
  readonly track = new MockTrack();
  getAudioTracks(): VoiceMediaTrack[] { return [this.track]; }
}
class MockPC implements VoicePeerConnection {
  connectionState = 'new';
  onicecandidate: ((ev: { candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null }) => void) | null = null;
  ontrack: ((ev: { streams: VoiceMediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  localDesc: { type: string; sdp?: string } | null = null;
  remoteDesc: { type: string; sdp?: string } | null = null;
  candidates: unknown[] = [];
  addedTracks = 0;
  closed = false;
  addTrack(): void { this.addedTracks++; }
  async createOffer(): Promise<{ type: 'offer'; sdp?: string }> { return { type: 'offer', sdp: 'v=0 mock-offer' }; }
  async createAnswer(): Promise<{ type: 'answer'; sdp?: string }> { return { type: 'answer', sdp: 'v=0 mock-answer' }; }
  async setLocalDescription(desc: { type: 'offer' | 'answer'; sdp?: string }): Promise<void> { this.localDesc = desc; }
  async setRemoteDescription(desc: { type: 'offer' | 'answer'; sdp?: string }): Promise<void> { this.remoteDesc = desc; }
  async addIceCandidate(candidate: unknown): Promise<void> { this.candidates.push(candidate); }
  close(): void { this.closed = true; }
  connect(): void { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
  fail(): void { this.connectionState = 'failed'; this.onconnectionstatechange?.(); }
}

function mockDeps(opts: { getUserMediaFails?: boolean } = {}): { deps: VoiceRtcDeps; pcs: MockPC[]; configs: { iceServers: { urls: string[] }[] }[]; played: VoiceMediaStream[]; muted: boolean[]; stream: MockStream } {
  const pcs: MockPC[] = [];
  const configs: { iceServers: { urls: string[] }[] }[] = [];
  const played: VoiceMediaStream[] = [];
  const muted: boolean[] = [];
  const stream = new MockStream();
  const deps: VoiceRtcDeps = {
    createPeerConnection: (config) => {
      configs.push(config);
      const pc = new MockPC();
      pcs.push(pc);
      return pc;
    },
    getUserMedia: async () => {
      if (opts.getUserMediaFails) throw new Error('denied');
      return stream;
    },
    playRemoteAudio: (s) => { played.push(s); },
    setRemoteMuted: (m) => { muted.push(m); },
  };
  return { deps, pcs, configs, played, muted, stream };
}

const teammates = [
  { playerId: 'mate-1', displayName: 'Mate One' },
  { playerId: 'mate-2', displayName: 'Mate Two' },
];

async function enabledRadio(sent: { to: string; signal: VoiceSignalOut }[] = []): Promise<{ radio: VoiceRadio; m: ReturnType<typeof mockDeps> }> {
  const m = mockDeps();
  const radio = new VoiceRadio('me', (to, signal) => { sent.push({ to, signal }); return true; }, () => { /* status listener */ }, m.deps);
  await radio.enable(teammates);
  return { radio, m };
}

test('voice constants: free public STUN only (no TURN), 10 s burst cap', () => {
  assert.ok(VOICE_STUN_URLS.length > 0);
  for (const url of VOICE_STUN_URLS) {
    assert.ok(url.startsWith('stun:'));
    assert.ok(!url.includes('turn:'));
  }
  assert.equal(VOICE_MAX_BURST_MS, 10_000);
});

test('voice unsupported in Node (no browser WebRTC) — enable fails cleanly, never throws', async () => {
  assert.equal(isVoiceSupported(), false);
  const radio = new VoiceRadio('me', () => true, () => { /* noop */ }, null);
  assert.equal(await radio.enable(teammates), false);
  assert.equal(radio.getStatus().status, 'unavailable');
});

test('enable acquires the mic (disabled until talk), announces join to each teammate, status ready', async () => {
  const sent: { to: string; signal: VoiceSignalOut }[] = [];
  const { radio, m } = await enabledRadio(sent);
  assert.equal(radio.getStatus().status, 'ready');
  assert.equal(m.stream.track.enabled, false); // mic off until hold-to-talk
  assert.deepEqual(sent.map((s) => `${s.to}:${s.signal.kind}`), ['mate-1:join', 'mate-2:join']);
});

test('mic permission denied → failed with plain-words detail, no throw', async () => {
  const m = mockDeps({ getUserMediaFails: true });
  const radio = new VoiceRadio('me', () => true, () => { /* noop */ }, m.deps);
  assert.equal(await radio.enable(teammates), false);
  assert.equal(radio.getStatus().status, 'failed');
  assert.match(radio.getStatus().detail, /Microphone unavailable/);
});

test('hold to talk enables the mic; release disables it; mute blocks talking', async () => {
  const { radio, m } = await enabledRadio();
  assert.equal(radio.startTalk(), true);
  assert.deepEqual(
    { status: radio.getStatus().status, talking: radio.getStatus().talking },
    { status: 'talking', talking: true },
  );
  assert.equal(m.stream.track.enabled, true);
  radio.stopTalk();
  assert.equal(radio.getStatus().status, 'ready');
  assert.equal(radio.getStatus().talking, false);
  assert.equal(m.stream.track.enabled, false);
  radio.setMuted(true);
  assert.equal(radio.startTalk(), false); // muted: cannot talk
  assert.equal(radio.getStatus().muted, true);
  radio.setMuted(false);
  assert.equal(radio.startTalk(), true);
});

test('a burst auto-stops at 10 s — the mic never stays live', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { radio, m } = await enabledRadio();
    assert.equal(radio.startTalk(), true);
    mock.timers.tick(9_999);
    assert.equal(radio.getStatus().talking, true);
    mock.timers.tick(2);
    assert.equal(radio.getStatus().talking, false);
    assert.equal(m.stream.track.enabled, false);
    assert.match(radio.getStatus().detail, /10 seconds/);
  } finally {
    mock.timers.reset();
  }
});

test('disable tells teammates leave, closes peers, stops the mic', async () => {
  const sent: { to: string; signal: VoiceSignalOut }[] = [];
  const { radio, m } = await enabledRadio(sent);
  await radio.handleSignal({ fromPlayerId: 'mate-1', kind: 'join' });
  assert.equal(m.pcs.length, 1);
  radio.disable();
  assert.equal(radio.getStatus().status, 'off');
  assert.deepEqual(sent.filter((s) => s.signal.kind === 'leave').map((s) => s.to), ['mate-1', 'mate-2']);
  assert.equal(m.pcs[0]?.closed, true);
  assert.equal(m.stream.track.stopped, true);
});

test('a teammate join makes US offer (exactly one offerer, no glare)', async () => {
  const sent: { to: string; signal: VoiceSignalOut }[] = [];
  const { radio, m } = await enabledRadio(sent);
  await radio.handleSignal({ fromPlayerId: 'mate-1', kind: 'join' });
  assert.equal(m.pcs.length, 1);
  assert.equal(m.pcs[0]?.localDesc?.type, 'offer');
  assert.deepEqual(sent.filter((s) => s.signal.kind === 'offer').map((s) => s.to), ['mate-1']);
});

test('an offer is answered; an answer sets the remote description; ICE is added', async () => {
  const sent: { to: string; signal: VoiceSignalOut }[] = [];
  const { radio, m } = await enabledRadio(sent);
  await radio.handleSignal({ fromPlayerId: 'mate-2', kind: 'offer', sdp: 'v=0 their-offer' });
  assert.deepEqual(m.pcs[0]?.remoteDesc, { type: 'offer', sdp: 'v=0 their-offer' });
  assert.equal(m.pcs[0]?.localDesc?.type, 'answer');
  assert.deepEqual(sent.filter((s) => s.signal.kind === 'answer').map((s) => s.to), ['mate-2']);
  await radio.handleSignal({ fromPlayerId: 'mate-2', kind: 'answer', sdp: 'v=0 their-answer' });
  await radio.handleSignal({ fromPlayerId: 'mate-2', kind: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5000 typ host' } });
  assert.equal(m.pcs[0]?.candidates.length, 1);
});

test('peer connections use STUN-only config (no TURN, no credentials)', async () => {
  const { radio, m } = await enabledRadio();
  await radio.handleSignal({ fromPlayerId: 'mate-1', kind: 'join' });
  assert.equal(m.configs.length, 1);
  const urls = m.configs[0]?.iceServers.flatMap((s) => s.urls) ?? [];
  assert.deepEqual(urls, [...VOICE_STUN_URLS]);
  assert.ok(urls.every((u) => u.startsWith('stun:')));
});

test('a signal from a non-teammate is ignored — no peer connection opens', async () => {
  const { radio, m } = await enabledRadio();
  await radio.handleSignal({ fromPlayerId: 'stranger', kind: 'offer', sdp: 'v=0 evil' });
  await radio.handleSignal({ fromPlayerId: 'me', kind: 'offer', sdp: 'v=0 self' });
  assert.equal(m.pcs.length, 0);
});

test('a failed peer (direct P2P blocked, no TURN) is reported and closed — the radio survives', async () => {
  const m = mockDeps();
  const radio = new VoiceRadio('me', () => true, () => { /* noop */ }, m.deps);
  await radio.enable(teammates);
  await radio.handleSignal({ fromPlayerId: 'mate-1', kind: 'join' });
  assert.equal(m.pcs.length, 1);
  m.pcs[0]?.fail();
  assert.deepEqual(radio.getStatus().failedPeerIds, ['mate-1']);
  assert.match(radio.getStatus().detail, /could not connect directly/i);
  assert.equal(m.pcs[0]?.closed, true);
  assert.notEqual(radio.getStatus().status, 'failed'); // the radio itself stays up; text still works
});

test('a teammate leave closes only that peer', async () => {
  const { radio, m } = await enabledRadio();
  await radio.handleSignal({ fromPlayerId: 'mate-1', kind: 'join' });
  await radio.handleSignal({ fromPlayerId: 'mate-2', kind: 'join' });
  assert.equal(m.pcs.length, 2);
  await radio.handleSignal({ fromPlayerId: 'mate-1', kind: 'leave' });
  assert.equal(m.pcs[0]?.closed, true);
  assert.equal(m.pcs[1]?.closed, false);
});
