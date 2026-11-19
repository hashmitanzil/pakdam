# @pakdam/engine

Pure game-logic package for Pakdam. **Pure functions + state transitions
only** — no I/O, no Worker/DO imports, no web imports; imports only
`@pakdam/shared`. The Durable Object enforces these rules authoritatively;
the demo store and the web app mirror them.

## Public API

### `src/state-machine.ts` — the 12 phases

- `MATCH_PHASES` — all 12 phases in order (re-exported from shared).
- `MATCH_PHASE_TRANSITIONS` — allowed phase transitions (re-exported from shared).
- `TERMINAL_PHASES` — `COMPLETED / CANCELLED / ABANDONED / EXPIRED` (re-exported from shared).
- `MatchPhase` — the 12-phase type (re-exported from shared).
- `TransitionResult` — `{ ok: true, phase }` or `{ ok: false, reason, code: 'INVALID_STATE' }`.
- `isTerminalPhase(phase)` — is this phase terminal (no outgoing edge)?
- `canTransition(from, to)` — is this edge allowed?
- `transition(from, to)` — attempt a transition; same-phase is a no-op success, illegal edge rejects with reason.
- `transitionOrThrow(from, to)` — like `transition`, but throws an `INVALID_STATE` error on an illegal edge.
- `MatchEvent` — named match events (`room-created`, `start-requested`, `countdown-complete`, `head-start-elapsed`, `match-end`, `resolve-complete`, `cancel`, `abandon`, `expire`, `pause`, `resume`).
- `transitionForEvent(from, event, pausedFrom?)` — map a named event to its target phase, then apply `transition`; `resume` needs `pausedFrom`.
- `isLivePhase(phase)` — clock runs here (HEAD_START / ACTIVE / SAFETY_PAUSED).
- `isPlayPhase(phase)` — match running, not finished (HEAD_START / ACTIVE).

### `src/modes.ts` — Classic + Infection

- `ModePlayer` — minimal seat shape the mode rules need (id, role, ejectedAt, leftAt).
- `isRunnerFree(player, caughtRunnerIds)` — is this Runner still in play?
- `runnerIds(players)` — every Runner id on the roster.
- `freeRunnerIds(players, caughtRunnerIds)` — free (still in play) Runner ids.
- `resolveModeOutcome({ mode, players, caughtRunnerIds, durationSeconds? })` — Hunters win when no Runner is left free, else Runners win; ejected Runners count as out but appear in neither list.
- `TagApplication` — Classic `out` (role stays runner, now caught) vs Infection `flip` (role becomes hunter).
- `applyConfirmedTag(mode)` — what a confirmed tag does to the tagged Runner.
- `maybeCompleteOnWin({ mode, players, caughtRunnerIds, durationSeconds? })` — the outcome when the match is over after a tag/ejection, else null.
- `outcomeLabel(outcome)` — human-readable outcome label for results.

### `src/roles.ts` — host-controlled teams

- `BALANCED_HUNTER_TABLE` — the balance table (re-exported from shared).
- `balancedHunterCount(rosterSize)` — Hunter count from the roster size (re-exported from shared).
- `RolePlayer` — minimal seat shape role assignment needs (id only).
- `RoleDrawOptions` — host toggles: `balanceHunters`, `randomDraw`, `teamAssignment`, `hostHunterCount`, `selectedHunterIds`, `pickHunterCount` (the count the pick was made against — stale picks fall back to a random draw), optional seeded `random`.
- `AssignRolesResult` — `{ ok: true, hunterCount, hunterIds, runnerIds, assignments }` or `{ ok: false, reason }`.
- `resolveHunterCount({ balanceHunters, rosterSize, hostHunterCount })` — Balance ON reads the table; OFF uses the host stepper (clamped 1..n−1).
- `validateSelectedHunters({ selectedHunterIds, hunterCount, joinedPlayerIds })` — pick problems in plain words, or null when valid.
- `shuffled(items, random?)` — Fisher–Yates shuffle of a copy.
- `assignRoles(players, options)` — draw roles once, at head start; ≥ 3 players, 1..n−1 Hunters; `selected` uses the host pick (stale-count pick falls back to a random draw), `random` shuffles.
- `clearSelectedHunters()` — switching to Random (or changing hunter count / assignment) clears the pick.

### `src/zone.ts` — zones, shrink, outside-zone

- `OUTSIDE_ZONE_RETURN_SECONDS` — 30 s return countdown, then ejection (fixed founder rule).
- `ZONE_RADIUS_MIN_M` — zone radius minimum 100 m (re-exported from shared).
- `haversineMeters(a, b)` — great-circle distance in metres (re-exported from shared).
- `pointInPolygon(point, polygon)` — ray casting; a point on the boundary counts as inside.
- `distancePointToSegmentMeters(point, a, b)` — point-to-segment distance in metres.
- `polygonCentroid(polygon)` — vertex average (may sit outside a concave shape).
- `zoneDiameterMeters(polygon)` — widest pair of vertices, in metres.
- `circlePolygon(centre, radiusMeters, points?)` — N-point circle approximation.
- `scalePolygonTowardPoint(polygon, point, factor)` — scale toward a point.
- `scalePolygonTowardCentroid(polygon, factor)` — scale toward the centroid.
- `offsetPolygon(polygon, dxMeters, dyMeters)` — offset every vertex by metres.
- `polygonFullyInside(inner, outer)` — all vertices inside AND no edge crossing.
- `isPointInZone(point, boundary)` — is this point inside the play zone?
- `shrinkTimesSeconds(durationSeconds, intervalSeconds, shrinkEnabled)` — shrink times from match start.
- `shrinkIndexAt(elapsedSeconds, intervalSeconds, shrinkEnabled)` — how many shrinks have fired.
- `nextShrinkAtMs(startedAtMs, durationSeconds, intervalSeconds, shrinkEnabled, nowMs)` — epoch ms of the next shrink, or null.
- `ShrinkDrawResult` — `{ boundary, method, offsetMeters }`.
- `randomOffsetShrinkBoundary(boundary, { factor?, random?, maxAttempts? })` — scale to 75%, move to a random position fully inside the old boundary, never concentric; fallbacks: compass → vertex → smaller concentric → concentric last resort.
- `OutsideZoneState` — per-player countdown state (`outsideSinceMs`, `outsideAccumMs`; DO memory only).
- `emptyOutsideZoneState()` — fresh countdown state.
- `OutsideZoneUpdate` — `{ state, remainingSeconds, shouldEject }`.
- `updateOutsideZone(state, { inside, poorAccuracy, nowMs })` — advance the countdown; poor GPS freezes it, back inside clears it.
- `applyOutsideZoneEjection(player, nowMs)` — set `ejectedAt`; idempotent, never undone by rejoining.

### `src/pings.ts` — pings stay until the next ping

- `PING_AREA_RADIUS_M` — ping area radius 150 m (re-exported from shared).
- `PENDING_PING_TTL_SECONDS` — pending (undelivered) ping TTL 300 s (re-exported from shared).
- `isPingDue(lastPingAtMs, startedAtMs, intervalSeconds, nowMs)` — is a ping due? First ping lands one interval after match start.
- `nextPingAtMs(lastPingAtMs, startedAtMs, intervalSeconds)` — epoch ms of the next scheduled ping, or null.
- `buildPing({ pingId, roomId, subjectPlayerId, fix, qualityAtPing, nowMs })` — one coarse 150 m ping area; null when there is no fix, never an invented position.
- `isPingDeliverable(ping, nowMs, ttlSeconds?)` — is an undelivered ping still within its TTL?
- `purgeExpiredPings(pendingPings, nowMs, ttlSeconds?)` — drop undelivered pings past their TTL.
- `replaceDeliveredPing(delivered, next)` — a delivered ping stays until the next ping replaces it.
- `pingAgeSeconds(ping, nowMs)` — age in whole seconds, for the `m:ss ago` label.
- `withAge(ping, nowMs)` — a delivered ping with its age filled in.
- `dueRunnerIds({ freeRunnerIds, fixes, lastPingAtMs, startedAtMs, intervalSeconds, nowMs })` — which free Runners are due a ping now.

### `src/catch.ts` — tag → QR → runner confirms → manual fallback

- `CATCH_CONFIRMATION_REQUIRED` — runner confirmation is always required (re-exported from shared).
- `CATCH_TOKEN_TTL_SECONDS` — catch-token TTL 120 s (re-exported from shared).
- `isValidCatchToken(token)` — is this a fresh ≥ 128-bit catch token? (re-exported from shared).
- `PENDING_CATCH_STATES` — `requested` / `awaiting-confirmation`.
- `isPendingCatch(catchEvent)` — is this catch still pending?
- `isCatchExpired(catchEvent, nowMs, ttlSeconds?)` — has this claim expired (lazy expiry)?
- `toCatchView(catchEvent)` — strip the server-only token hash for clients.
- `IdempotencyRecord` — one `(seat, commandId)` seen record.
- `isDuplicateCommand(seen, seatPlayerId, commandId, nowMs)` — is this a repeat inside the 10-min window?
- `rememberCommand(seen, seatPlayerId, commandId, nowMs)` — record a `(seat, commandId)` as seen (new map, input untouched).
- `purgeIdempotency(seen, nowMs)` — drop idempotency records older than the TTL.
- `issueCatchToken(catchId)` — fresh 128-bit token (QR only) + its stored hash.
- `verifyCatchToken(catchId, rawToken, storedHash)` — does this raw token match the stored hash?
- `gpsEvidenceForCatch(hunterFix, runnerFix, nowMs)` — `present` / `absent` / `stale` (supporting evidence only, never proof).
- `CatchResult<T>` — `{ ok: true, value }` or `{ ok: false, reason, code }`.
- `CatchPlayer` — minimal seat shape the catch rules need.
- `isCatchableRunner(player, caughtRunnerIds)` — free, present, non-suspended Runner.
- `openCatchForRunner(catches, runnerId)` — the open (pending) claim against a Runner, if any.
- `requestCatch({ catches, hunter, runner, caughtRunnerIds, phase, catchId, roomId, nowMs, hunterFix, runnerFix })` — Hunter only, ACTIVE only, one pending catch per Runner; same-Hunter re-request returns the open claim, different Hunter gets CONFLICT.
- `confirmCatch({ catchEvent, confirmerId, confirmerRole, manualConfirm, tokenValid, runner, caughtRunnerIds, phase, nowMs, ttlSeconds? })` — Runner (QR token or manual, no token) or claiming Hunter (valid QR token); suspended Runner blocks; second confirm is CONFLICT.
- `disputeCatch({ catchEvent, disputerId, phase, nowMs, ttlSeconds? })` — Runner-only, on a pending claim; overdue claims expire instead.
- `resolveCatch({ catchEvent, resolverIsHost, decision, nowMs })` — host resolves a disputed catch (`confirmed` / `rejected`); final.
- `expireCatchIfOverdue(catchEvent, nowMs, ttlSeconds?)` — lazily expire an overdue pending claim.
- `selectEffectiveRunner({ urlRunnerId, myOpenClaim, myPlayerId, pickerChoiceId, myLatestConfirmedCatch })` — catch-page auto-select order: URL param → my open claim → picker choice → my latest confirmed catch; null means render the picker.
- `pickerCandidates(players, selfId, caughtRunnerIds)` — name-only picker candidates (self, ejected/left, already-caught excluded).

### `src/safety.ts` — SOS / safety pause

- `SOS_COPY` — exact SOS copy: SOS alerts the host; Pakdam is NOT an emergency service (re-exported from shared).
- `canSafetyPause(phase)` — pause allowed from HEAD_START / ACTIVE (already-paused is a harmless no-op).
- `canStartSafetyPause(phase)` — a fresh pause may start here (HEAD_START / ACTIVE).
- `PauseResult` — `{ ok: true, phase: 'SAFETY_PAUSED', pausedFrom, pausedAt }` or `{ ok: false, reason, code }`.
- `pauseMatch(phase, byPlayerId, nowMs)` — start a safety pause; records `pausedAt` + `pausedFrom`.
- `ResumeResult` — `{ ok: true, phase, startedAt, endsAt }` (deadlines shifted) or `{ ok: false, reason, code }`.
- `shiftDeadlineForward(deadline, pauseDurationMs)` — shift an ISO deadline forward by the pause.
- `resumeMatch({ phase, pausedFrom, pausedAt, startedAt, endsAt, nowMs })` — resume returns to the phase paused from, deadlines shifted; nothing completes while paused.
- `safetyStateAfterPause(byPlayerId, nowMs, previous)` — snapshot safety state after a pause.
- `safetyStateAfterResume(previous)` — snapshot safety state after a resume (SOS unchanged).
- `raiseSos(previous)` — raise an SOS (host-only recipients, not emergency dispatch).
- `clearSos(previous)` — clear an SOS (host-acknowledged).
- `sosRecipients(hostPlayerId)` — SOS recipients: the host only.

### `src/suspension.ts` — suspension / resume on hello

- `SUSPENSIONS_BEFORE_HOST_CHECKIN` — 3 repeated suspensions raise a host check-in (re-exported from shared).
- `SuspensionReason` — `tab-hidden` / `screen-locked` / `network-lost` / `heartbeat-timeout` / `unknown` (re-exported from shared).
- `SuspendablePlayer` — minimal seat shape the suspension rules need.
- `suspensionNeedsHostCheckin(suspensionCount)` — does this count raise a host check-in?
- `recordSuspension(player, reason)` — mark suspended, increment the count, report whether the host must check in.
- `suspendOnSocketClose(player)` — mark a seat suspended on socket close.
- `ResumeResult<T>` — `{ resumed, player }`.
- `resumeSuspendedPlayer(player, nowMs)` — resume on hello/reconnect (P0-1); no-op unless actually suspended; count stays on the record.
- `canCompleteCatchWhileSuspended(player)` — a pending catch can never complete while the Runner is suspended.
- `isSuspended(player)` — is this seat suspended ("location unknown")?

### `src/scoring.ts` — scoring per mode

- `SCORING_CLEAN_SWEEP`, `SCORING_HUNTER_PER_TAG`, `SCORING_RUNNER_NEVER_CAUGHT`, `SCORING_RUNNER_PER_3_MIN_FREE` — scoring constants (re-exported from shared).
- `RUNNER_FREE_SECONDS_PER_POINT` — 180 s of free time earns one Runner point.
- `ScoringPlayer` — minimal per-player scoring input (role at end, free seconds, caught, ejected, tags made).
- `isCleanSweep({ result, ejectedRunnerIds })` — every Runner caught, none ejected, none surviving, Hunters won.
- `runnerScore(player)` — +1 per whole 3 min free, +10 if never caught.
- `hunterScore(player, cleanSweep, huntersWon)` — +3 per confirmed tag, +10 clean sweep when it applies.
- `scorePlayer(player, { result, cleanSweep })` — points for one player (0 when the match never completed).
- `ScoreBreakdown` — per-player breakdown (points, free blocks, never-caught bonus, tags, clean-sweep bonus).
- `scoreMatch({ players, result, ejectedRunnerIds })` — score a completed match; 0 for every player when there is no result.

### `src/snapshot.ts` — snapshot building with ROLE SECRECY

- `playerViewFor(viewerPlayerId, player)` — one seat as a viewer sees it: hash stripped, own role only, other seats' roles `null`.
- `playersViewFor(viewerPlayerId, players)` — every seat as this viewer sees it.
- `activeCatchesFor(viewerPlayerId, viewerIsHost, catches)` — pending catches only, to the parties + the host.
- `buildSnapshot({ room, players, viewerPlayerId, viewerIsHost, serverSeq, locationStatus, catches, safetyState, missedAnnouncements })` — the authorised snapshot: no raw coordinates, no pending pings, no token hashes, ever.
