/**
 * v34 Scope C (Tara) — the 9 takes + Scope D item 10 fixes + the
 * three small follow-ups (A: requestId error matching, B: demo
 * suspended-Hunter self-confirm, C: B6 play-page scroll measurement).
 *
 * Pure helpers are behaviour-tested; page wiring is pinned by source
 * checks (wiring pins, not behaviour proofs — only the founder's
 * phone / CI proves the flows end to end).
 */
import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./resolve-hooks.mjs', import.meta.url);

// -- A stub `window.localStorage` (+ sessionStorage, which the demo
//    store uses for the current player id) for the storage-backed
//    helpers (onboarding seen-flag, saved Custom preset). The demo
//    store also reads it, so rooms created in this file persist to the
//    stub.
const storeMap = new Map();
const sessionMap = new Map();
const memoryStorage = (map) => ({
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
});
globalThis.window = {
  localStorage: memoryStorage(storeMap),
  sessionStorage: memoryStorage(sessionMap),
};

const {
  applyHousePreset,
  HOUSE_PRESETS,
  loadCustomPreset,
  matchBuiltInPreset,
  matchHousePreset,
  matchesCustomPreset,
  saveCustomPreset,
} = await import('../src/lib/house-rules.ts');
const { ONBOARDING_CARDS, hasSeenOnboarding, markOnboardingSeen } = await import(
  '../src/lib/onboarding.ts'
);
const { confirmErrorMatches } = await import('../src/lib/self-confirm-error.ts');
const { shortStartBlocker } = await import('../src/lib/live-room-client.ts');
const { formatRoomSummary } = await import('../src/components/host-setup/draft.ts');
const { DEFAULT_ROOM_CONFIG, formatAgeLabel } = await import('@pakdam/shared');
const { circlePolygon } = await import('@pakdam/engine');
const demoStore = await import('../src/lib/demo-store.ts');
const {
  createRoom,
  recordPlayerSuspension,
  requestCatch,
  resumePlayer,
  selfConfirmCatch,
  startDemoMatch,
  tickDemoRoom,
} = demoStore;

const SRC = new URL('./../src/', import.meta.url);
const readSrc = (path) => readFileSync(new URL(path, SRC), 'utf8');

const TEST_CONFIG = {
  ...DEFAULT_ROOM_CONFIG,
  hostOnSiteConfirmed: true,
  headStartSeconds: 0,
  durationSeconds: 600,
  zone: { boundary: circlePolygon({ lat: 23.3441, lng: 85.3096 }, 500), shrinkPhases: [] },
};

/** A demo lobby room with host Teo + Ana + Ben (mirrors v32). */
function threePlayerLobby() {
  const demo = createRoom('Teo', TEST_CONFIG);
  const host = demo.players[0];
  const joined = (offsetMs) => new Date(Date.parse(host.joinedAt) + offsetMs).toISOString();
  const ana = {
    ...host,
    playerId: 'ana-player-id',
    displayName: 'Ana',
    isHost: false,
    isReady: false,
    briefingConfirmed: false,
    joinedAt: joined(1000),
  };
  const ben = {
    ...host,
    playerId: 'ben-player-id',
    displayName: 'Ben',
    isHost: false,
    isReady: false,
    briefingConfirmed: false,
    joinedAt: joined(2000),
  };
  demo.players.push(ana, ben);
  return { demo, host, ana, ben };
}

function startMatch(demo) {
  for (const p of demo.players) {
    p.isReady = true;
    p.briefingConfirmed = true;
  }
  startDemoMatch(demo);
  const startedAtMs = Date.parse(demo.room.startedAt);
  tickDemoRoom(demo, startedAtMs + 1000);
  assert.equal(demo.room.phase, 'ACTIVE', 'headStart 0 must reach ACTIVE on the first tick');
  const hunter = demo.players.find((p) => p.matchRole === 'hunter');
  const runners = demo.players.filter((p) => p.matchRole === 'runner');
  assert.ok(hunter, 'the match must draw a hunter');
  assert.ok(runners.length >= 2, 'the match must draw two runners');
  return { hunter, runners };
}

// --- C5: house-rules presets ------------------------------------------

test('C5: the three presets match their own values and nothing else', () => {
  const quick = { durationSeconds: 600, headStartSeconds: 60, pingIntervalSeconds: 30, zoneShrinkEnabled: true };
  assert.equal(matchBuiltInPreset(quick, 200), 'quick');
  assert.equal(matchBuiltInPreset(quick, null), 'quick', 'a drawn zone ignores the radius');
  const standard = { durationSeconds: 1800, headStartSeconds: 180, pingIntervalSeconds: 180, zoneShrinkEnabled: true };
  assert.equal(matchBuiltInPreset(standard, 500), 'standard');
  const big = { durationSeconds: 3600, headStartSeconds: 300, pingIntervalSeconds: 300, zoneShrinkEnabled: true };
  assert.equal(matchBuiltInPreset(big, 800), 'big-park');
  // One field off = changed (Custom), not a preset.
  assert.equal(matchBuiltInPreset({ ...standard, pingIntervalSeconds: 60 }, 500), null);
  assert.equal(matchBuiltInPreset(standard, 200), null, 'Standard with a Quick-sized zone is not Standard');
  assert.equal(HOUSE_PRESETS.length, 3, 'exactly Quick / Standard / Big park as built-ins');
});

test('C5: applying a preset sets timing + shrink interval (3 shrinks per game)', () => {
  const base = { ...DEFAULT_ROOM_CONFIG, durationSeconds: 1800, zoneShrinkIntervalSeconds: 600 };
  const quick = HOUSE_PRESETS.find((p) => p.id === 'quick');
  const applied = applyHousePreset(base, quick);
  assert.equal(applied.durationSeconds, 600);
  assert.equal(applied.headStartSeconds, 60);
  assert.equal(applied.pingIntervalSeconds, 30);
  assert.equal(applied.zoneShrinkIntervalSeconds, 180, '10 min round shrinks every 3 min');
  const big = HOUSE_PRESETS.find((p) => p.id === 'big-park');
  assert.equal(applyHousePreset(base, big).zoneShrinkIntervalSeconds, 1200, '60 min round shrinks every 20 min');
  // The original config is not mutated.
  assert.equal(base.durationSeconds, 1800);
});

test('C5: a saved Custom preset round-trips and matches by value', () => {
  assert.equal(loadCustomPreset(), null, 'nothing saved yet');
  saveCustomPreset({
    durationSeconds: 900,
    headStartSeconds: 120,
    pingIntervalSeconds: 60,
    zoneRadiusMeters: 300,
    zoneShrinkEnabled: true,
  });
  const custom = loadCustomPreset();
  assert.ok(custom, 'the saved Custom preset must load back');
  assert.equal(custom.id, 'custom');
  assert.equal(custom.durationSeconds, 900);
  const changed = { durationSeconds: 900, headStartSeconds: 120, pingIntervalSeconds: 60, zoneShrinkEnabled: true };
  assert.equal(matchesCustomPreset(changed, 300, custom), true);
  assert.equal(matchesCustomPreset(changed, 500, custom), false, 'a different zone size is not the saved Custom');
  assert.equal(matchHousePreset(changed, 300, custom), 'custom');
  assert.equal(matchHousePreset(changed, 300, null), 'custom', 'unsaved changed settings also read as Custom');
});

// --- C1: onboarding -----------------------------------------------------

test('C1: exactly 3 rule cards + a final Your turn card, in Pakdam words', () => {
  assert.equal(ONBOARDING_CARDS.length, 4);
  assert.deepEqual(
    ONBOARDING_CARDS.map((c) => c.kicker),
    ['THE ZONE', 'HIDDEN', 'THE SQUEEZE', 'YOUR TURN'],
  );
  assert.match(ONBOARDING_CARDS[0].body, /30 seconds/, 'the zone card states the 30 s return rule');
  assert.match(ONBOARDING_CARDS[1].body, /hidden/i, 'the hidden card says runners stay hidden');
  assert.match(ONBOARDING_CARDS[2].body, /quarter/, 'the squeeze card states the quarter shrink');
  assert.match(ONBOARDING_CARDS[3].body, /2 or more friends/, 'the final card states the player count');
  for (const card of ONBOARDING_CARDS) {
    assert.ok(card.body.length <= 200, 'cards stay short — one plain sentence each');
  }
});

test('C1: the seen flag starts unset and marks seen once', () => {
  storeMap.delete('pakdam.onboarding.seen.v1');
  assert.equal(hasSeenOnboarding(), false);
  markOnboardingSeen();
  assert.equal(hasSeenOnboarding(), true);
});

// --- A: requestId error matching ----------------------------------------

test('A (R2-14 seam 2): an id-carrying error matches only its own command', () => {
  // The server's rejection of THIS confirm, echoed with its id.
  assert.equal(
    confirmErrorMatches({ errorRequestId: 'cmd-1', pendingRequestId: 'cmd-1', errorAtMs: 5000, pendingAtMs: 1000 }),
    true,
  );
  // A location.update STALE_LOCATION arriving 2 s after the OK tap,
  // carrying the location command's id — must NOT read as the confirm's failure.
  assert.equal(
    confirmErrorMatches({ errorRequestId: 'cmd-loc', pendingRequestId: 'cmd-1', errorAtMs: 3000, pendingAtMs: 1000 }),
    false,
  );
  // A pending confirm that never recorded an id cannot claim an id-carrying error.
  assert.equal(
    confirmErrorMatches({ errorRequestId: 'cmd-1', pendingRequestId: null, errorAtMs: 2000, pendingAtMs: 1000 }),
    false,
  );
});

test('A: with no requestId on the envelope, the 15 s window still applies', () => {
  assert.equal(
    confirmErrorMatches({ errorRequestId: null, pendingRequestId: 'cmd-1', errorAtMs: 14_000, pendingAtMs: 1000 }),
    true,
    '14 s after the tap, no id — the old behaviour still surfaces the error',
  );
  assert.equal(
    confirmErrorMatches({ errorRequestId: null, pendingRequestId: 'cmd-1', errorAtMs: 16_000, pendingAtMs: 1000 }),
    false,
    'at 15 s the window is closed, exactly as before',
  );
  assert.equal(
    confirmErrorMatches({ errorRequestId: undefined, pendingRequestId: 'cmd-1', errorAtMs: 500, pendingAtMs: 1000 }),
    false,
    'an error from before the tap never matches',
  );
});

// --- C7: short Start blocker labels --------------------------------------

test('C7: the blocked Start button states its own blocker', () => {
  assert.equal(shortStartBlocker('Need at least 2 players — share the room code above.', 1), 'NEED 2+ PLAYERS TO START');
  assert.equal(shortStartBlocker('Waiting for: Ana, Ben.', 3), 'WAITING FOR PLAYERS');
  assert.equal(shortStartBlocker('Pick 2 Hunters first.', 3), 'PICK HUNTERS FIRST');
  assert.equal(shortStartBlocker('Hunter count must leave at least one Runner — lower it or wait for more players.', 3), 'TOO MANY HUNTERS');
  assert.equal(shortStartBlocker(null, 3), 'START GAME', 'a passing gate reads START GAME');
  assert.equal(shortStartBlocker('Something else went wrong.', 3), 'CANNOT START YET');
});

// --- B: demo suspended-Hunter self-confirm -------------------------------

test('B: a demo self-confirm against an already-open claim refuses a suspended Hunter (live parity)', () => {
  const { demo } = threePlayerLobby();
  const { hunter, runners } = startMatch(demo);
  const runner = runners[0];
  // The claim opens while the Hunter is present…
  const { catch: claim } = requestCatch(demo, hunter.playerId, runner.playerId);
  assert.equal(claim.state, 'awaiting-confirmation');
  // …then the Hunter goes away. Live refuses the tag (v18); demo used
  // to complete it through the open claim, skipping requestCatch.
  recordPlayerSuspension(demo, hunter.playerId, 'tab-hidden');
  assert.equal(hunter.connectionState, 'suspended');
  assert.throws(
    () => selfConfirmCatch(demo, runner.playerId, hunter.playerId),
    /A suspended or disconnected Hunter cannot tag\./,
    'an open claim must not let a suspended Hunter tag in demo',
  );
  assert.equal(
    demo.catches.find((c) => c.catchId === claim.catchId)?.state,
    'awaiting-confirmation',
    'the refused self-confirm leaves the open claim alone — it is not confirmed, not rolled back',
  );
  // The Hunter comes back: the same self-confirm now completes.
  assert.equal(resumePlayer(demo, hunter.playerId), true);
  const confirmed = selfConfirmCatch(demo, runner.playerId, hunter.playerId);
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.catchId, claim.catchId, 'the same claim confirms, no duplicate');
});

// --- Already-built takes, pinned against regression ----------------------
// (C2 role reveal, C3 PTT timer pill, C8 summary strip — Meera's build
//  already had these; these pins lock them so Scope C cannot regress them.)

test('C2 (pin): the role reveal is one full-screen moment, not a banner', () => {
  const play = readSrc('app/room/[roomId]/play/page.tsx');
  assert.ok(play.includes('fixed inset-0 z-50'), 'the reveal covers the whole screen');
  // The source writes the apostrophe as the escape `You\u2019re it.` —
  // match the literal source text, not the decoded character.
  assert.ok(play.includes('You\\u2019re it.'), 'the hunter reveal is the giant "You\u2019re it." moment');
  assert.ok(play.includes('Let&apos;s go'), 'one "Let\u2019s go" button dismisses it');
});

test('C3 (pin): the PTT timer pill reads "0:03 · let go to send" while talking', () => {
  assert.equal(formatAgeLabel(3), '0:03');
  const ptt = readSrc('components/radio/PTTButton.tsx');
  assert.ok(ptt.includes('· let go to send'), 'the pill carries the "let go to send" line');
  const strip = readSrc('components/radio/RadioStrip.tsx');
  assert.ok(strip.includes('Message your team'), 'the text input stays visible next to the mic');
  assert.ok(strip.includes('<PTTButton'), 'the strip still renders the mic button');
});

test('C8 (pin): the lobby summary strip is one line of the whole config', () => {
  const config = {
    ...DEFAULT_ROOM_CONFIG,
    durationSeconds: 1800,
    pingIntervalSeconds: 180,
    zone: { boundary: circlePolygon({ lat: 23.3441, lng: 85.3096 }, 500), shrinkPhases: [] },
  };
  assert.equal(formatRoomSummary(config, 6), '500m zone · 2 hunters · 3m pulse · 30m');
  const lobby = readSrc('app/room/[roomId]/page.tsx');
  assert.ok(lobby.includes('formatRoomSummary(config, activePlayers.length)'), 'the lobby renders the strip');
});

// --- Wiring pins for this round's builds ---------------------------------

test('C1/C9 (wiring): home shows the cards once, has three doors, and re-opens them', () => {
  const home = readSrc('app/page.tsx');
  assert.ok(home.includes('<OnboardingCards'), 'home renders the onboarding cards');
  assert.ok(home.includes('hasSeenOnboarding()'), 'the cards auto-show only before the first game');
  assert.ok(home.includes('HOST A GAME'), 'door 1: Host');
  assert.ok(home.includes('JOIN A GAME'), 'door 2: Join with a code');
  assert.ok(home.includes('TRY A DEMO'), 'door 3: demo');
  assert.ok(home.includes('/create/mode?demo=1'), 'the demo door carries the demo flag');
  assert.ok(home.includes('How to play'), 'How to play re-opens the cards');
  const mode = readSrc('app/create/mode/page.tsx');
  assert.ok(mode.includes("get('demo') === '1'"), 'the mode page reads the demo flag');
  assert.ok(mode.includes('Demo round — played on this device only'), 'the demo mode says what it is');
});

test('C4 (wiring): Get help is one tap away in the More sheet', () => {
  const sheet = readSrc('components/hud/MoreSheet.tsx');
  assert.ok(sheet.includes('Get help'), 'the More sheet has a Get help row');
  assert.ok(sheet.includes('In trouble during a round?'), 'the help line is plain words');
  assert.ok(sheet.includes('Safety pause'), 'the help points at Safety pause, not at a new feature');
});

test('C5/C6/C7 (wiring): setup has presets, sections with explainers, and a blocking CTA', () => {
  const controls = readSrc('components/host-setup/SetupControls.tsx');
  assert.ok(controls.includes('HouseRulesPresets'), 'presets live in the setup controls');
  assert.ok(controls.includes('Quick'), 'preset: Quick');
  assert.ok(controls.includes('Big park'), 'preset: Big park');
  assert.ok(controls.includes('Changed. Save them to pick them next time.'), 'the changed line + Save');
  assert.ok(controls.includes('TimingControls'), 'the timing steppers are their own section');
  assert.ok(controls.includes('aria-label="Timing"'), 'section: Timing');
  assert.ok(controls.includes('aria-label="Rules"'), 'section: Rules');
  assert.ok(controls.includes('aria-label="Players"'), 'section: Players');
  assert.ok(controls.includes('How many Hunters the match draws.'), 'every control has its line — Hunters stepper included');
  assert.ok(controls.includes('The zone is on — runners must stay inside it.'), 'the Play zone toggle explains itself when on, too');
  const setup = readSrc('app/room/[roomId]/setup/page.tsx');
  assert.ok(setup.includes('aria-label="Play area"'), 'section: Play area');
  assert.ok(setup.includes('Circle: one round zone. Draw: your own shape'), 'the shape switch explains itself');
  assert.ok(setup.includes('<HouseRulesPresets'), 'the presets sit above the steppers on the setup screen');
  assert.ok(setup.includes('PLACE AT LEAST 3 CORNERS'), 'CREATE LOBBY states its zone blocker');
  const lobby = readSrc('app/room/[roomId]/page.tsx');
  assert.ok(lobby.includes('shortStartBlocker(gate.reason, activePlayers.length)'), 'Start uses the short blocker label');
});

test('A (wiring): the catch page sends the commandId and matches on requestId', () => {
  const ws = readSrc('lib/websocket.ts');
  assert.ok(ws.includes('sendCommandReturningId'), 'the socket can return the sent commandId');
  assert.ok(ws.includes("sendCatchSelfConfirm(hunterId: string): string | null"), 'self-confirm returns its commandId');
  const catchPage = readSrc('app/room/[roomId]/catch/page.tsx');
  assert.ok(catchPage.includes('pendingConfirmRequestIdRef'), 'the page keeps the pending confirm id');
  assert.ok(catchPage.includes('confirmErrorMatches({'), 'the error effect matches by requestId');
  assert.ok(!catchPage.includes('second seam — OPEN'), 'the R2-14 OPEN seam note is gone');
  const state = readSrc('components/match/useRoomState.ts');
  assert.ok(state.includes('requestId?: string'), 'the hook carries the echoed requestId through');
});

test('B (wiring): demo self-confirm checks the Hunter suspension before reusing an open claim', () => {
  const store = readSrc('lib/demo-store.ts');
  const fn = store.slice(store.indexOf('export function selfConfirmCatch'));
  assert.ok(
    fn.includes("hunter.connectionState === 'suspended'"),
    'selfConfirmCatch itself checks the Hunter suspension, not just requestCatch',
  );
});

test('D10 (wiring): every error state has plain words + a working Retry', () => {
  const lobby = readSrc('app/room/[roomId]/page.tsx');
  const lobbyErrorBranch = lobby.slice(lobby.indexOf('session === null || loadError'));
  assert.ok(lobbyErrorBranch.includes('Retry'), 'the lobby error branch offers Retry');
  const results = readSrc('app/room/[roomId]/results/page.tsx');
  assert.ok(
    (results.match(/onClick={retryScores}/g) ?? []).length >= 2,
    'scores Retry exists in the main branch AND the removed-seat branch',
  );
});

// --- C: B6 scroll-on-map measurement (from code) --------------------------
// Play page, base case (no banners): pt-3 (12) + StatusStrip (~150 max:
// 32 px clock + labels + shrink/runners rows + padding) + gap (12) +
// map (420, fixed) + gap (12) + Tag button (56) + pb-24 (96, clears the
// fixed 64 px BottomTabs) = ~758 px. That fits a ~800 px viewport and,
// on a shorter one, the page SCROLLS: <main> is min-h-dvh with no fixed
// height and no overflow trap, and BottomTabs is `fixed` (out of flow).
// A finger ON the map pans the map (MapLibre's canvas takes the touch,
// by design); a finger anywhere else scrolls the page. No layout fix.
test('B6 (measurement): the play page fits by scrolling — no height trap, map pan by design', () => {
  const play = readSrc('app/room/[roomId]/play/page.tsx');
  // Every <main> on the page (error branches and the play render alike)
  // must grow with content — none may be a fixed viewport height or
  // trap scrolling.
  const mainClasses = [...play.matchAll(/<main className="([^"]*)"/g)].map((m) => m[1].split(' '));
  assert.ok(mainClasses.length >= 2, 'the play page renders more than one <main> branch');
  for (const cls of mainClasses) {
    assert.ok(cls.includes('min-h-dvh'), 'every play <main> grows with content (min-h-dvh)');
    assert.ok(!cls.includes('h-dvh'), 'no play <main> is a fixed viewport height');
    assert.ok(!cls.includes('overflow-hidden'), 'no play <main> traps scrolling');
  }
  assert.ok(play.includes('h-[420px]'), 'the map is a fixed 420 px — it never grows past the viewport');
  assert.ok(play.includes('pb-24'), 'bottom padding clears the fixed tab bar');
  const tabs = readSrc('components/ui/BottomTabs.tsx');
  assert.ok(tabs.includes('fixed inset-x-0 bottom-0'), 'the tab bar is fixed, out of flow — it takes no layout height');
  const statusStripPx = 150; // generous ceiling for the strip (32 px clock + 3 rows + padding)
  const contentPx = 12 + statusStripPx + 12 + 420 + 12 + 56 + 96;
  assert.ok(contentPx <= 800, `base content is ~${contentPx} px — fits an ~800 px viewport; shorter screens scroll, which the layout allows`);
});
