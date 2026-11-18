/**
 * k6 — 16-player multiplayer load simulation (founder-approved final stack).
 *
 * What it does: 1 host creates a room via POST /v1/rooms, 15 guests
 * join via POST /v1/rooms/:id/join, every player takes a WS ticket,
 * opens a WebSocket, sends `hello`, then sends a location.update
 * every 5 s for the run duration. The host starts the match once
 * everyone is in. The run FAILS only on functional checks (room not
 * created, a join rejected, a WS not connected) — latency is RECORDED
 * (p95) with NO pass/fail threshold: no threshold is invented here;
 * the founder sets the bar from the first measured run.
 *
 * What it does NOT do: it does not test the PWA (that is Playwright),
 * it does not test Supabase writes (the Worker/DO is the authority
 * for live play), and it does not run against localhost by default —
 * it needs a reachable Worker URL.
 *
 * Run (k6 is a Go binary — install it from k6.io; it is NOT in this
 * repo. 2026-11-17: k6 v1.4.0 was downloaded as a tarball from
 * github.com/grafana/k6/releases and run from scratch storage — the
 * binary is NOT committed to the repo, so re-download it per machine):
 *
 *   k6 run -e WORKER_URL=https://<your-worker>.workers.dev \
 *          -e HEAD_START=60 workers/load/k6-16-player.js
 *
 * Wire-shape fix 2026-11-17: `hello` now carries its `payload`
 * (protocolVersion/clientVersion/lastServerSeq) and `location.update`
 * nests the fix under `payload` — the real wire shape
 * (apps/web/src/lib/websocket.ts sendCommand). The previous script sent
 * both without a payload, which the DO rejects (validateHello 4400/4409;
 * location.update VALIDATION_FAILED — a top-level fix is never read).
 *
 * Or against local wrangler dev (with a TEST join limit — the 16 VUs
 * share one IP, 127.0.0.1, so the 5/min/IP placeholder, OPEN HNT-071,
 * would 429 all but 5 joins. The limit is env-configurable; the
 * production default stays 5/min/IP and is never raised silently —
 * set the test value ONLY for the local run, leave deployments unset):
 *
 *   npx wrangler dev --port 8787 --var PAKDAM_JOIN_PER_MINUTE:100   # in workers/
 *   k6 run -e WORKER_URL=http://127.0.0.1:8787 workers/load/k6-16-player.js
 *
 * Notes:
 * - Room codes are 6 chars; the host's invite link carries the roomId
 *   UUID, the code is the invite proof in the join body.
 * - The WS handshake needs a ticket: POST /v1/rooms/:id/ws-ticket
 *   with { playerId, reconnectToken } (the token the join response
 *   returned once). The ticket is single-use, 60 s TTL (placeholder).
 * - Location updates use a fixed Ranchi-area point per player with a
 *   small deterministic offset — this is a LOAD test, not a GPS test;
 *   real movement is covered by the field-test gate, not by k6.
 * - 16 players is the OLD cap used by the load-test name; the roster
 *   cap is now 30 (founder, 2026-11-17). The script simulates 16
 *   (the approved k6 scenario); a 30-player run is the same script
 *   with GUESTS=29.
 */
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';

const WORKER_URL = __ENV.WORKER_URL || 'http://127.0.0.1:8787';
const GUESTS = Number(__ENV.GUESTS || 15); // 15 guests + 1 host = 16 players
const DURATION_S = Number(__ENV.DURATION_S || 60);
const HEAD_START = Number(__ENV.HEAD_START || 60);

export const options = {
  // One VU per player; all 16 start together (the pilot's worst case
  // is a full room joining at once, not a slow trickle).
  vus: GUESTS + 1,
  // One iteration per VU: each player joins ONCE and holds its WS for
  // DURATION_S. The previous `duration`-only form looped VUs, so each
  // VU re-joined every iteration and burned the per-IP join budget
  // (5/min, placeholder — OPEN HNT-071) in seconds, then spun on 429s
  // for the rest of the run. `iterations` is the same player count as
  // `vus`, so every VU still runs exactly once.
  iterations: GUESTS + 1,
  // No latency thresholds — see the header. Only the http error rate
  // is capped, because a failed request is a functional failure.
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};

const ZONE = [
  { lat: 23.35, lng: 85.32 },
  { lat: 23.35, lng: 85.325 },
  { lat: 23.355, lng: 85.325 },
  { lat: 23.355, lng: 85.32 },
];

function roomConfig() {
  return {
    mode: 'classic', teamAssignment: 'random', maxPlayers: 30, hunterCount: 1,
    durationSeconds: 600, headStartSeconds: HEAD_START, pingIntervalSeconds: 180,
    zoneShrinkEnabled: false, zoneShrinkIntervalSeconds: 300,
    catchConfirmationRequired: true, playZoneEnabled: true,
    balanceHunters: true, randomDraw: true,
    zone: { boundary: ZONE, shrinkPhases: [] },
    safeAreas: [], noGoAreas: [], selectedHunterIds: [],
    hostOnSiteConfirmed: true,
  };
}

function post(path, body) {
  return http.post(`${WORKER_URL}${path}`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export function setup() {
  const res = post('/v1/rooms', {
    displayName: 'Load Host', kind: 'guest',
    config: roomConfig(), ageGatePassed: true,
  });
  check(res, { 'room created (201)': (r) => r.status === 201 });
  if (res.status !== 201) {
    throw new Error(`setup: room creation failed: ${res.status} ${res.body}`);
  }
  const room = res.json();
  return {
    roomId: room.roomId, roomCode: room.roomCode,
    hostPlayerId: room.hostPlayerId, hostReconnectToken: room.reconnectToken,
  };
}

export default function (data) {
  const isHost = __VU === 1;
  const name = isHost ? 'Load Host' : `Guest ${__VU}`;
  // The host's seat already exists (created in setup); the setup
  // response carries its playerId + reconnect token, so the host
  // uses them directly — it does NOT re-join. Guests join by code.
  let playerId = null;
  let reconnectToken = null;
  if (isHost) {
    playerId = data.hostPlayerId;
    reconnectToken = data.hostReconnectToken;
  } else {
    const res = post(`/v1/rooms/${data.roomId}/join`, {
      displayName: name, kind: 'guest', roomCode: data.roomCode,
    });
    check(res, { 'guest joined (200)': (r) => r.status === 200 });
    if (res.status === 200) {
      const j = res.json();
      // The join response nests the seat: { ok, player: { playerId,
      // … }, reconnectToken, restored } (room-do-class.ts add-player).
      // Reading a top-level playerId returns undefined and the guest
      // silently never requests a ticket or WS — the 2026-11-17
      // 5-player run showed exactly that (7/7 checks, 1 WS session).
      playerId = j.player.playerId;
      reconnectToken = j.reconnectToken;
    }
  }
  if (!playerId) return;

  const ticketRes = post(`/v1/rooms/${data.roomId}/ws-ticket`, { playerId, reconnectToken });
  check(ticketRes, { 'ws ticket issued (200)': (r) => r.status === 200 });
  if (ticketRes.status !== 200) return;
  const ticket = ticketRes.json().ticket;

  const url = `${WORKER_URL.replace('http', 'ws')}/v1/rooms/${data.roomId}/ws?ticket=${ticket}`;
  const wsRes = ws.connect(url, {}, (socket) => {
    socket.on('open', () => {
      // hello carries a payload (docs/API.md §3.3): protocolVersion 1,
      // clientVersion, lastServerSeq. A hello without it is rejected
      // by the DO's validateHello (4400/4409).
      socket.send(JSON.stringify({
        type: 'hello', v: 1, roomId: data.roomId, playerId,
        clientTs: Date.now(), commandId: `hello-${__VU}`,
        payload: { protocolVersion: 1, clientVersion: 'k6-load/1.0', lastServerSeq: 0 },
      }));
      // One location.update every 5 s: a small deterministic offset
      // per player so the 16 fixes are not identical (identical
      // fixes are rejected as duplicates by the DO). The fix travels
      // NESTED under `payload` — the real wire shape
      // (apps/web/src/lib/websocket.ts sendCommand); a top-level fix
      // is never read by the DO and is rejected as VALIDATION_FAILED.
      const lat = 23.352 + (__VU % 4) * 0.0004;
      const lng = 85.321 + Math.floor(__VU / 4) * 0.0004;
      socket.setInterval(() => {
        socket.send(JSON.stringify({
          type: 'location.update', v: 1, roomId: data.roomId, playerId,
          clientTs: Date.now(), commandId: `loc-${__VU}-${Date.now()}`,
          payload: {
            fix: {
              playerId, roomId: data.roomId, lat, lng, accuracyMeters: 8,
              capturedAt: new Date().toISOString(),
              receivedAt: new Date().toISOString(), quality: 'good',
            },
          },
        }));
      }, 5000);
    });
    socket.on('message', () => { /* state broadcasts are counted, not parsed */ });
    socket.setTimeout(() => socket.close(), DURATION_S * 1000);
  });
  check(wsRes, { 'websocket connected (101)': (r) => r && r.status === 101 });
  sleep(1);
}

export function teardown(data) {
  // The room is left to expire; no delete endpoint exists by design
  // (rooms are purged at match end / TTL). The run's evidence is the
  // k6 summary: checks passed + p95 latencies, no invented threshold.
  console.log(`load run finished for room ${data.roomId} (${GUESTS + 1} players)`);
}
