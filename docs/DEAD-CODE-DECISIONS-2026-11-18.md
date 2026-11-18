# Dead-code decisions — Pakdam leftover fixes, 2026-11-18

Wire-or-delete decisions for the orphaned exports found during the
2026-11-18 leftover-fixes push. Evidence is grep over `apps/web/src`
(+ `apps/web/e2e` where noted) at the time of the decision. "No caller"
means no import/call outside the defining file (comments do not count).

**Concurrent-edit warning (read first):** a second agent worked the
same item list in parallel during this session (first seen ~00:22 IST,
2026-11-18). The deletions marked "deleted by parallel agent" below
were made by that agent, not by this push — this file records them
because the decision (delete, with the evidence) is the same either
way. The one destructive collision is `live-room-client.ts`, which
that agent overwrote with a 5-byte file (see BLOCKER).

## DELETE — done by the parallel agent during this session

| Item | Evidence (no caller) | What happened |
|---|---|---|
| `apps/web/src/hooks/useLiveRoom.ts` (330 lines, whole file) | No page imports it (`grep useLiveRoom` → only a comment in `live-room-client.ts:14`). The play page uses `createLivePakdamSocket` directly (`play/page.tsx:10`); the lobby page uses REST fns from `live-room-client`. Superseded duplicate of `useRoom` — both headers claim to be "the one hook", neither is called. | File + `src/hooks/` deleted by parallel agent (~00:22 IST). |
| `apps/web/src/components/map/OfflineMapNotice.tsx` | Never rendered (only a comment in `lib/offline-map/cache.ts:9`). Its own header says it is not rendered by the live map view and to wire it in when the PMTiles mode switch lands. | File deleted by parallel agent (~00:22 IST). Recreate from `docs/OFFLINE-MAP.md` when the PMTiles mode switch is wired. |
| `apps/web/src/lib/offline-map/index.ts` (barrel) | Never imported (`grep offline-map'` → no importers). Pure `export *` re-export. | File deleted by parallel agent (~00:22 IST). The modules (`cache.ts`, `constants.ts`, `mode.ts`, `pmtiles-loader.ts`) remain, still unwired — map-agent owned, see note below. |
| `demo-store.ts`: `HostDashboard` (was :62), `addDemoPlayers` (was :240), `getHostDashboard` (was :400) | No external refs in `src` or `e2e`; no internal uses either (`getHostDashboard` was the only user of `HostDashboard`; `addDemoPlayers` only its own definition). Neither demo-store suite imports them (dynamic imports list only `createRoom, joinRoom, toggleReady, setPhase, getRoom, tickDemoRoom, requestCatch, …`). | Deleted by parallel agent (~00:25 IST), including the now-unused `zoneDiameterMeters` engine import. |
| `geolocation.ts`: `isFairFix`, `getLatestWatchedFix` | No refs outside the file. `isGoodFix` is KEPT — it is used internally (`geolocation.ts:234,328,362` region, now re-numbered). The `latestWatchedFix` module var is KEPT — still read by `getCurrentFix` (reuse-if-good-and-fresh). Only the two dead accessors went. | Deleted by parallel agent (~00:24 IST). |
| `live-client.ts`: `liveSocketStateMessage` | No refs outside the file; only its definition + one comment, both removed. | Deleted by parallel agent (~00:24 IST). |
| `offline-queue.ts`: `drainQueue` | No refs outside the file. The module stays live (`queueNonCompetitive` used by help/contact/grievance; `OfflineQueueItem` type used by the admin page, which reads the localStorage key directly). | Deleted by parallel agent (~00:24 IST). |

## KEEP — with evidence (not actually dead)

| Item | Evidence |
|---|---|
| `live-client.ts`: `LiveCreateResult`, `LiveJoinResult` | Declared return/parameter types of live-called functions: `createLiveRoom(): Promise<LiveCreateResult>` (called by `app/create/page.tsx:63`), `joinLiveRoom(): Promise<LiveJoinResult>` (called by `app/join/[code]/page.tsx:51`, `app/join/page.tsx:99`), `storeLiveSeat(result: LiveCreateResult \| LiveJoinResult, …)` (called by all three pages). Deleting them would only force inlining the same shapes into three signatures. Verified still exported after the parallel agent's pass (`live-client.ts:192,239`). |
| `lib/offline-map/` modules (`cache.ts`, `constants.ts`, `mode.ts`, `pmtiles-loader.ts`) | Unwired (only importer was the now-deleted `OfflineMapNotice`), but they are the map work's substrate, described by `docs/OFFLINE-MAP.md`, and owned by the map agent. Deleting them is out of scope for a leftover-fixes push. Flagged, not deleted. |

## RESOLVED — `live-room-client.ts` rewritten (was transiently truncated)

`apps/web/src/lib/live-room-client.ts` was briefly a 5-byte file
(`test\n`, 2026-11-17 18:53:14 UTC) while the parallel agent rewrote
it mid-session. Final state (verified 2026-11-18 ~00:40 IST): **235
lines, REST helpers only** — `fetchLiveRoomState, fetchHostToken,
startLiveMatch, updateLiveRoomConfig, removeLivePlayer,
regenerateLiveRoomCode, resolveLiveCatch, fetchLiveCatchToken`
(`live-room-client.ts:131-230`). The `LiveRoomClient` class and
`useRoom()` hook were **DELETED** by the parallel agent, with the same
rationale this push reached independently (no page ever called them;
pages drive `createLivePakdamSocket()` directly; "Do not re-add a
wrapper hook or client class here without wiring a page to it in the
same change" — file header lines 19-24). The supporting-only exports
went with them (`LivePingArea`, `LiveRoomSubscriber`,
`UseRoomResult`, `snapshotToDemoRoom`, `restStateToDemoRoom`). The
room page's four REST imports and `websocket-reconnect.test.ts`
(17/17 green) cover what remains. No action needed from this push;
the transient truncation is recorded here only so the mid-session
breakage is not mistaken for a current problem.

## Other decisions in this push (for the record)

- `draft.ts` (`draftToConfig`): stored shrink phases are now SIZE
  PLACEHOLDERS ONLY — concentric scaled copies via
  `scalePolygonTowardCentroid`, no `randomOffsetShrinkBoundary` at
  creation. The server draws the real zone per shrink (`room-do.ts`
  alarmTick). Next-zone preview wording updated in `NextZonePanel.tsx`,
  `play/page.tsx` (comment), `MapLibreMapView.tsx` (legend) to say
  plainly the preview is the planned size, not the final zone.
- B-P3-01: the fix code already existed (Worker 4, 2026-11-18 —
  `startMatch` seeds `lastZoneBoundary`, `room-do.ts:335-346`;
  alarmTick seeds silently when `phaseIndex === 0`,
  `room-do.ts:967-977`). This push added the missing regression
  tests (`workers/test/alarm-tick.test.ts`, two tests).
