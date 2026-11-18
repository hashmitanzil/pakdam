import { describe, expect, it, vi } from 'vitest';
import {
  VoiceRadio, VOICE_MAX_BURST_MS, VOICE_STUN_URLS, isVoiceSupported,
  type VoiceMediaStream, type VoiceMediaTrack, type VoicePeerConnection, type VoiceRtcDeps, type VoiceSignalOut,
} from '../apps/web/src/lib/voice-radio.js';

/**
 * Voice radio (D-M1) — WebRTC peer-to-peer manager, tested with mock
 * RTC deps (no real microphone, no real peer connection, no network).
 * Run: `npm run test:vitest` (root).
 */

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
  /** Drive the connection to 'connected' the way a real PC would. */
  connect(): void { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
  /** Drive the connection to 'failed' (e.g. symmetric NAT, no TURN). */
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

describe('voice radio constants (free P2P only)', () => {
  it('uses free public STUN only — no TURN relay anywhere', () => {
    expect(VOICE_STUN_URLS.length).toBeGreaterThan(0);
    for (const url of VOICE_STUN_URLS) {
      expect(url.startsWith('stun:')).toBe(true);
      expect(url.includes('turn:')).toBe(false);
    }
  });
  it('caps a push-to-talk burst at 10 seconds', () => {
    expect(VOICE_MAX_BURST_MS).toBe(10_000);
  });
  it('is unsupported in Node (no browser WebRTC) — enable fails cleanly, never throws', async () => {
    expect(isVoiceSupported()).toBe(false);
    const radio = new VoiceRadio('me', () => true, () => { /* noop */ }, null);
    expect(await radio.enable(teammates)).toBe(false);
    expect(radio.getStatus().status).toBe('unavailable');
  });
});

describe('VoiceRadio enable / PTT', () => {
  it('enable acquires the mic (disabled until talk), announces join to each teammate, status ready', async () => {
    const sent: { to: string; signal: VoiceSignalOut }[] = [];
    const { radio, m } = await enabledRadio(sent);
    expect(radio.getStatus().status).toBe('ready');
    expect(m.stream.track.enabled).toBe(false); // mic off until hold-to-talk
    expect(sent.map((s) => `${s.to}:${s.signal.kind}`)).toEqual(['mate-1:join', 'mate-2:join']);
  });
  it('mic permission denied → failed with plain-words detail, no throw', async () => {
    const m = mockDeps({ getUserMediaFails: true });
    const radio = new VoiceRadio('me', () => true, () => { /* noop */ }, m.deps);
    expect(await radio.enable(teammates)).toBe(false);
    expect(radio.getStatus().status).toBe('failed');
    expect(radio.getStatus().detail).toMatch(/Microphone unavailable/);
  });
  it('hold to talk enables the mic; release disables it; mute blocks talking', async () => {
    const { radio, m } = await enabledRadio();
    expect(radio.startTalk()).toBe(true);
    expect(radio.getStatus()).toMatchObject({ status: 'talking', talking: true });
    expect(m.stream.track.enabled).toBe(true);
    radio.stopTalk();
    expect(radio.getStatus()).toMatchObject({ status: 'ready', talking: false });
    expect(m.stream.track.enabled).toBe(false);
    radio.setMuted(true);
    expect(radio.startTalk()).toBe(false); // muted: cannot talk
    expect(radio.getStatus().muted).toBe(true);
    radio.setMuted(false);
    expect(radio.startTalk()).toBe(true);
  });
  it('a burst auto-stops at 10 s — the mic never stays live', async () => {
    vi.useFakeTimers();
    try {
      const { radio, m } = await enabledRadio();
      expect(radio.startTalk()).toBe(true);
      vi.advanceTimersByTime(9_999);
      expect(radio.getStatus().talking).toBe(true);
      vi.advanceTimersByTime(2);
      expect(radio.getStatus().talking).toBe(false);
      expect(m.stream.track.enabled).toBe(false);
      expect(radio.getStatus().detail).toMatch(/10 seconds/);
    } finally {
      vi.useRealTimers();
    }
  });
  it('disable tells teammates leave, closes peers, stops the mic', async () => {
    const sent: { to: string; signal: VoiceSignalOut }[] = [];
    const { radio, m } = await enabledRadio(sent);
    await radio.handleSignal({ fromPlayerId: 'mate-1', kind: 'join' });
    expect(m.pcs.length).toBe(1);
    radio.disable();
    expect(radio.getStatus().status).toBe('off');
    expect(sent.filter((s) => s.signal.kind === 'leave').map((s) => s.to)).toEqual(['mate-1', 'mate-2']);
    expect(m.pcs[0]?.closed).toBe(true);
    expect(m.stream.track.stopped).toBe(true);
  });
});

describe('VoiceRadio signalling (mesh, one offerer)', () => {
  it('a teammate join makes US offer (exactly one offerer, no glare)', async () => {
    const sent: { to: string; signal: VoiceSignalOut }[] = [];
    const { radio, m } = await enabledRadio(sent);
    await radio.handleSignal({ fromPlayerId: 'mate-1', kind: 'join' });
    expect(m.pcs.length).toBe(1);
    expect(m.pcs[0]?.localDesc?.type).toBe('offer');
    expect(sent.filter((s) => s.signal.kind === 'offer').map((s) => s.to)).toEqual(['mate-1']);
  });
  it('an offer is answered; an answer sets the remote description; ICE is added', async () => {
    const sent: { to: string; signal: VoiceSignalOut }[] = [];
    const { radio, m } = await enabledRadio(sent);
    await radio.handleSignal({ fromPlayerId: 'mate-2', kind: 'offer', sdp: 'v=0 their-offer' });
    expect(m.pcs[0]?.remoteDesc).toEqual({ type: 'offer', sdp: 'v=0 their-offer' });
    expect(m.pcs[0]?.localDesc?.type).toBe('answer');
    expect(sent.filter((s) => s.signal.kind === 'answer').map((s) => s.to)).toEqual(['mate-2']);
    await radio.handleSignal({ fromPlayerId: 'mate-2', kind: 'answer', sdp: 'v=0 their-answer' });
    await radio.handleSignal({ fromPlayerId: 'mate-2', kind: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5000 typ host' } });
    expect(m.pcs[0]?.candidates.length).toBe(1);
  });
  it('peer connections use STUN-only config (no TURN, no credentials)', async () => {
    const { radio, m } = await enabledRadio();
    await radio.handleSignal({ fromPlayerId: 'mate-1', kind: 'join' });
    expect(m.configs.length).toBe(1);
    const urls = m.configs[0]?.iceServers.flatMap((s) => s.urls) ?? [];
    expect(urls).toEqual([...VOICE_STUN_URLS]);
    expect(urls.every((u) => u.startsWith('stun:'))).toBe(true);
  });
  it('a signal from a non-teammate is ignored — no peer connection opens', async () => {
    const { radio, m } = await enabledRadio();
    await radio.handleSignal({ fromPlayerId: 'stranger', kind: 'offer', sdp: 'v=0 evil' });
    await radio.handleSignal({ fromPlayerId: 'me', kind: 'offer', sdp: 'v=0 self' });
    expect(m.pcs.length).toBe(0);
  });
  it('a failed peer (direct P2P blocked, no TURN) is reported and closed — the radio survives', async () => {
    const statuses: string[] = [];
    const m = mockDeps();
    const radio = new VoiceRadio('me', () => true, (info) => { statuses.push(info.status); }, m.deps);
    await radio.enable(teammates);
    await radio.handleSignal({ fromPlayerId: 'mate-1', kind: 'join' });
    expect(m.pcs.length).toBe(1);
    m.pcs[0]?.fail();
    expect(radio.getStatus().failedPeerIds).toEqual(['mate-1']);
    expect(radio.getStatus().detail).toMatch(/could not connect directly/i);
    expect(m.pcs[0]?.closed).toBe(true);
    expect(radio.getStatus().status).not.toBe('failed'); // the radio itself stays up; text still works
  });
  it('a teammate leave closes only that peer', async () => {
    const { radio, m } = await enabledRadio();
    await radio.handleSignal({ fromPlayerId: 'mate-1', kind: 'join' });
    await radio.handleSignal({ fromPlayerId: 'mate-2', kind: 'join' });
    expect(m.pcs.length).toBe(2);
    await radio.handleSignal({ fromPlayerId: 'mate-1', kind: 'leave' });
    expect(m.pcs[0]?.closed).toBe(true);
    expect(m.pcs[1]?.closed).toBe(false);
  });
});
