/**
 * Pakdam calibration — every named constant in one place.
 *
 * Three sections, in authority order:
 *  1. PROTOCOL — frozen wire contract v2.1. Do not change without a protocol bump.
 *  2. FIXED — founder-decided rules. NOT calibration. Do not re-open without the founder.
 *  3. OPEN — placeholders carried over from the old build. Every value here is a
 *     starting guess that MUST be replaced by measured field evidence before any
 *     public pilot. Never present an OPEN value as a measured requirement.
 *
 * Pure constants only — no I/O, no secrets.
 */

// ---------------------------------------------------------------------------
// 1. PROTOCOL — frozen contract v2.1
// ---------------------------------------------------------------------------

/** Wire protocol version. `hello` must carry exactly this; anything else → 4409. */
export const PROTOCOL_VERSION = 1 as const;

/** Client version string sent in `hello`. */
export const CLIENT_VERSION = 'pakdam-web/0.1.0' as const;

/** How long a (seat, commandId) idempotency record lives: 10 min. */
export const IDEMPOTENCY_TTL_MS = 600_000;

/** The DO warns once when the socket's ticket expires within this window. */
export const RENEWAL_WARNING_MS = 30_000;

/** WS ticket TTL: 60 s. OPEN — placeholder, not a measured value. */
export const WS_TICKET_TTL_MS = 60_000;

/** Reconnect attempts before the client enters `reconnect-failed`. OPEN. */
export const RECONNECT_MAX_ATTEMPTS = 5;

/** Reconnect backoff: base 1 s, doubled per attempt, ceiling 30 s, jitter ×0.5–1.0. OPEN. */
export const RECONNECT_BACKOFF_BASE_MS = 1_000;
export const RECONNECT_BACKOFF_CEILING_MS = 30_000;

/**
 * Heartbeat interval (client → server `heartbeat`, server → `heartbeat.ack`).
 * OPEN — the old build never ran a heartbeat at all, so no measured value exists.
 * 30 s is chosen deliberately: the WS ticket lives 60 s and the renewal warning
 * fires 30 s before expiry, so a 30 s heartbeat guarantees inbound traffic inside
 * the warning window. Measure in the field and replace.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Missed-heartbeat limit: after this many unanswered heartbeats the client stops
 * heartbeating and closes the socket (1006, 'heartbeat timeout') so the reconnect
 * path re-syncs via snapshot. Carried over from the old client's defaults.
 * OPEN — measure in the field.
 */
export const HEARTBEAT_MISSED_LIMIT = 3;

/** Latest fixes older than this are purged every DO tick; fixes purge at match end. */
export const FIX_TTL_MS = 120_000;

/** Redacted game-event log cap in the DO. */
export const GAME_EVENT_LOG_CAP = 500;

/** Lightweight event log cap in the DO (same 500 — it grows with every save). */
export const EVENT_LOG_CAP = 500;

/** Text radio: keep the last 50 messages per client, ephemeral, no backfill. */
export const RADIO_KEEP_LAST = 50;

/** Text radio: max 140 characters per message (enforced by the DO). */
export const RADIO_MAX_CHARS = 140;

/** Voice radio: max 10 s per push-to-talk burst. */
export const VOICE_MAX_BURST_MS = 10_000;

/** Voice radio: free public STUN only. No TURN, no recording, no storage. */
export const VOICE_STUN_SERVERS: readonly string[] = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
] as const;

/** Voice SDP payload cap: 8 KB. */
export const VOICE_SDP_MAX_BYTES = 8_192;

// ---------------------------------------------------------------------------
// 2. FIXED — founder rules, NOT calibration
// ---------------------------------------------------------------------------

/** Minimum players to start a match. Server gate AND client gate must agree. */
export const MIN_PLAYERS = 2;

/** Maximum players in a room. */
export const MAX_PLAYERS = 30;

/**
 * Earth geometry — the SINGLE source for every metres↔degrees conversion.
 * EARTH_RADIUS_M is the radius `haversineMeters` uses (gps-validation.ts);
 * METERS_PER_DEG_LAT is (R·π)/180 ≈ 111,194.9 m/deg — NOT the stale
 * 111,320, which made a nominal 500 m zone measure ~499 m. The engine's
 * `circlePolygon` and every web lat/lng↔metres conversion must use these,
 * never a local literal.
 */
export const EARTH_RADIUS_M = 6_371_000;

/** Metres per degree of latitude: (6,371,000 · π) / 180. */
export const METERS_PER_DEG_LAT = (EARTH_RADIUS_M * Math.PI) / 180;

/** Metres per degree of longitude at `latDegrees` (cos(lat) correction). */
export function metersPerDegreeLng(latDegrees: number): number {
  return METERS_PER_DEG_LAT * Math.cos((latDegrees * Math.PI) / 180);
}

/** Zone radius: minimum 100 m. */
export const ZONE_RADIUS_MIN_M = 100;

/** Zone radius: default 500 m. */
export const ZONE_RADIUS_DEFAULT_M = 500;

/**
 * Geometry bounds (validation): no zone / no-go / safe-area boundary may
 * carry more than 64 points, and no zone boundary may span more than
 * 100 km across (bounding-box diagonal) — a boundary spanning the planet
 * is rejected, not stored.
 */
export const MAX_GEOMETRY_POINTS = 64;
export const MAX_ZONE_DIAMETER_M = 100_000;

/** Zone radius stepper step: 50 m. */
export const ZONE_RADIUS_STEP_M = 50;

/**
 * Zone radius UI slider convenience range only (10 km). NEVER a cap —
 * the zone has no maximum by founder decision ("unlimited past 1 km").
 */
export const ZONE_RADIUS_UI_MAX_M = 10_000;

/** Minimum zone diameter: 200 m. */
export const ZONE_DIAMETER_MIN_M = 200;

/**
 * A zone is NEVER auto-centred on a GPS fix worse than ±50 m.
 * The host places it by hand instead.
 */
export const ZONE_AUTO_CENTRE_MAX_ACCURACY_M = 50;

/** Outside-zone return countdown: 30 s, then ejection. */
export const OUTSIDE_ZONE_RETURN_SECONDS = 30;

/** Each shrink keeps 75% of the radius (−25% per shrink). */
export const SHRINK_RADIUS_FACTOR = 0.75;

/** Shrinks per round: exactly 3, at duration/3, 2·duration/3, duration. */
export const SHRINK_COUNT_PER_ROUND = 3;

/** Shrink preview lead: the DO broadcasts the next zone this far ahead. */
export const PREVIEW_LEAD_SECONDS = 30;

/** Next-zone draws within 10 m of the current centre are discarded and re-drawn. */
export const MIN_NEXT_ZONE_OFFSET_M = 10;

/** Random next-zone draw attempts before the deterministic fallbacks. */
export const SHRINK_MAX_ATTEMPTS = 50;

/** Runner confirmation is ALWAYS required — a tag never counts at once. */
export const CATCH_CONFIRMATION_REQUIRED = true;

/**
 * Catch token: minimum 128 bits of entropy. The old token was 12 hex chars
 * (48 bits) — too short. Fresh tokens are 32 hex chars = 128 bits.
 * Same hash construction (sha256(catchId + ':' + raw)), same single-use + TTL
 * semantics, same QR-only carriage (never typed, never shown as text).
 */
export const CATCH_TOKEN_HEX_LENGTH = 32;
export const CATCH_TOKEN_BITS = 128;

/**
 * Physical-tag rule (founder decision): a tag confirms ONLY when the
 * Hunter and the Runner both have a recent fix and are within this
 * distance of each other. A tag must not complete with both phones in
 * different cities. Applies to the QR-token path AND the manual-confirm
 * path — the engine gates both in `confirmCatch` (and `requestCatch`).
 */
export const CATCH_MAX_DISTANCE_METERS = 100;

/** Scoring (completed matches only) — fixed founder rules, NOT calibration. */
export const SCORING_RUNNER_PER_3_MIN_FREE = 1;
export const SCORING_RUNNER_NEVER_CAUGHT = 10;
export const SCORING_HUNTER_PER_TAG = 3;
export const SCORING_CLEAN_SWEEP = 10;

/** One sessionStorage key holds the whole live session (two separate tokens inside). */
export const SESSION_STORAGE_KEY = 'pakdam.session.v1';

/** SOS copy — exact string. SOS alerts the host; it is NOT emergency dispatch. */
export const SOS_COPY =
  'SOS alerts your host in this game. Pakdam is NOT an emergency service and does not call police or ambulance. If you are in danger, call your local emergency number.';

/** Fixed string sent as the reason on `catch.dispute`. */
export const CATCH_DISPUTE_REASON =
  'Runner disputes this catch — the host reviews it in person.';

// ---------------------------------------------------------------------------
// 3. OPEN — measure in the field before any public pilot
// ---------------------------------------------------------------------------

/**
 * GPS accuracy quality tiers (metres). The SERVER — never the client — decides
 * the tier. Poor accuracy is warned, never treated as cheating.
 * OPEN — all three numbers are placeholders.
 */
export const ACCURACY_GOOD_M = 10;
export const ACCURACY_FAIR_M = 25;
export const ACCURACY_POOR_M = 60;

/** Catch proximity plausibility: hunter↔runner distance. Plausibility only, never proof. OPEN. */
export const CATCH_PROXIMITY_PLAUSIBILITY_M = 15;

/** Catch-token TTL: 120 s. OPEN. */
export const CATCH_TOKEN_TTL_SECONDS = 120;

/** Default ping interval: 180 s (3 min). OPEN. */
export const PING_INTERVAL_SECONDS_DEFAULT = 180;

/** Ping acceleration: 60 s. OPEN. */
export const PING_ACCELERATION_SECONDS = 60;

/** Disconnect grace: 60 s. OPEN. */
export const DISCONNECT_GRACE_SECONDS = 60;

/** Suspension freshness: 30 s. OPEN. */
export const SUSPENSION_FRESHNESS_SECONDS = 30;

/** Location freshness window: a fix older than this is 'unknown'. OPEN. */
export const LOCATION_FRESHNESS_SECONDS = 30;

/** Repeated suspensions before a host check-in is raised: 3. OPEN. */
export const SUSPENSIONS_BEFORE_HOST_CHECKIN = 3;

/** Pending (undelivered) ping TTL: 300 s. Governs undelivered pings only. OPEN. */
export const PENDING_PING_TTL_SECONDS = 300;

/** Quick-preset duration: 1800 s. OPEN. (Presets are cut from the UI; kept for reference.) */
export const QUICK_PRESET_DURATION_SECONDS = 1800;

/** Head-start default: 180 s (3 min). OPEN. */
export const HEAD_START_SECONDS_DEFAULT = 180;

/** Standard round duration: 1800 s (30 min) — the founder-decided default (BEHAVIOUR.md §2, SCRAM-SPEC §13). OPEN. */
export const STANDARD_DURATION_SECONDS = 1800;

/** Zone shrink interval default: 600 s (10 min). OPEN. */
export const ZONE_SHRINK_INTERVAL_SECONDS_DEFAULT = 600;

/**
 * Shrink grid (minutes) the "Shrinks every" stepper offers: 1, 3, 5, 10,
 * 15, 20. OPEN.
 */
export const SHRINK_INTERVAL_MINUTES_GRID: readonly number[] = [1, 3, 5, 10, 15, 20];

/**
 * Shrink interval that follows the round length: one shrink per third of
 * the game (3 shrinks per round), snapped to the nearest grid minute and
 * clamped to the valid 60–3600 s range. So a 10-min round shrinks every
 * ~3 min, a 30-min round every 10 min, a 60-min round every 20 min.
 * The host changing the round length re-derives this automatically.
 */
export function shrinkIntervalForDurationSeconds(durationSeconds: number): number {
  const targetMinutes = durationSeconds / 3 / 60;
  let best = SHRINK_INTERVAL_MINUTES_GRID[0] ?? 10;
  let bestDist = Math.abs(best - targetMinutes);
  for (const entry of SHRINK_INTERVAL_MINUTES_GRID) {
    const dist = Math.abs(entry - targetMinutes);
    if (dist < bestDist) {
      bestDist = dist;
      best = entry;
    }
  }
  return Math.max(60, Math.min(3600, best * 60));
}

/** Ping area radius: 150 m coarse area, never an exact pin. OPEN. */
export const PING_AREA_RADIUS_M = 150;

/** Clock-skew / replay guard: a fix > 5 min in the future is rejected. OPEN. */
export const CLOCK_SKEW_MS = 300_000;

/** A fix > 60 s old on arrival is rejected. OPEN. */
export const STALE_FIX_MS = 60_000;

/** Impossible movement: > 30 m/s from the previous fix warns only, never rejects. OPEN. */
export const MAX_PLAUSIBLE_SPEED_MPS = 30;

/** WRONG_SCAN_MAX / WRONG_SCAN_LOCK_SECONDS: DELETED — dead calibration
 * with no engine/worker reference. Failed confirms are already limited
 * by the WS `catch.confirm` 5/min/seat limit; do not re-add a separate
 * lockout. NOTE: the web catch page still imports these names for its
 * demo wrong-scan lockout — that usage must be removed there (Arjun). */

/**
 * Hunter balance table (Balance ON sets the Hunter count from the roster at start).
 * OPEN — calibration, not a founder rule.
 */
export const BALANCED_HUNTER_TABLE: readonly { readonly minPlayers: number; readonly maxPlayers: number; readonly hunters: number }[] =
  [
    { minPlayers: 2, maxPlayers: 4, hunters: 1 },
    { minPlayers: 5, maxPlayers: 8, hunters: 2 },
    { minPlayers: 9, maxPlayers: 16, hunters: 3 },
    { minPlayers: 17, maxPlayers: 24, hunters: 4 },
    { minPlayers: 25, maxPlayers: 30, hunters: 5 },
  ] as const;

/** Suggested zone radius: 200 m + 25 m per player beyond 3, capped at 1000 m — starting point only. OPEN. */
export const SUGGESTED_ZONE_RADIUS_BASE_M = 200;
export const SUGGESTED_ZONE_RADIUS_PER_PLAYER_M = 25;
export const SUGGESTED_ZONE_RADIUS_CAP_M = 1000;

/**
 * WS per-seat per-message rate limits. All numbers are OPEN placeholders.
 * `player.suspended` is exempt.
 */
export const WS_MESSAGE_RATE_LIMITS: Readonly<Record<string, { readonly limit: number; readonly windowSeconds: number } | 'exempt'>> =
  {
    'location.update': { limit: 60, windowSeconds: 10 },
    'catch.request': { limit: 5, windowSeconds: 60 },
    'catch.confirm': { limit: 5, windowSeconds: 60 },
    'catch.dispute': { limit: 5, windowSeconds: 60 },
    'signal.send': { limit: 10, windowSeconds: 60 },
    'radio.send': { limit: 10, windowSeconds: 60 },
    'pin.place': { limit: 10, windowSeconds: 60 },
    'voice.signal': { limit: 600, windowSeconds: 60 },
    'announcement.send': { limit: 5, windowSeconds: 60 },
    'reveal.send': { limit: 5, windowSeconds: 60 },
    'briefing.confirm': { limit: 5, windowSeconds: 60 },
    'ready.set': { limit: 10, windowSeconds: 60 },
    'safety.pause': { limit: 10, windowSeconds: 60 },
    'safety.resume': { limit: 10, windowSeconds: 60 },
    'safety.sos': { limit: 10, windowSeconds: 60 },
    leave: { limit: 3, windowSeconds: 60 },
    'player.suspended': 'exempt',
  } as const;

/** Fallback WS per-message rate limit when a type has no entry above. OPEN. */
export const WS_MESSAGE_RATE_LIMIT_DEFAULT = { limit: 20, windowSeconds: 60 } as const;

/**
 * HTTP per-route rate limits. The limits the old build HAD are carried over;
 * the routes the old build left un-limited get starting values here — all OPEN
 * placeholders to validate in the field. WARNING: a 30-player roster joining
 * inside a minute from one NAT IP is legitimate and must not be throttled by a
 * per-IP join cap; per-seat keys are used for seat-scoped actions.
 */
export const HTTP_RATE_LIMITS: Readonly<Record<string, { readonly limit: number; readonly windowSeconds: number; readonly key: 'ip' | 'seat' | 'room' }>> =
  {
    'POST /v1/rooms': { limit: 5, windowSeconds: 60, key: 'ip' },
    // NAT-JOIN: 30 players on one venue WiFi share one IP. Keyed by the
    // room code (not the IP) at 35/min — a full roster + retries/mistypes
    // inside a minute — so a crowded join never 429s the 6th player.
    'GET /v1/rooms/by-code/:code': { limit: 35, windowSeconds: 60, key: 'room' },
    'POST /v1/rooms/:id/join': { limit: 35, windowSeconds: 60, key: 'room' },
    // Join-by-code (single call: registry lookup folded into the join).
    // Same 35/min/code bucket as the two-call join path — a full roster
    // on one venue WiFi joins inside a minute without a 429.
    'POST /v1/rooms/join-by-code': { limit: 35, windowSeconds: 60, key: 'room' },
    'POST /v1/rooms/:id/ws-ticket': { limit: 10, windowSeconds: 60, key: 'seat' },
    'POST /v1/rooms/:id/ws-ticket/revoke': { limit: 10, windowSeconds: 60, key: 'seat' },
    'POST /v1/rooms/:id/start': { limit: 5, windowSeconds: 60, key: 'seat' },
    'POST /v1/reports': { limit: 5, windowSeconds: 60, key: 'ip' },
    'POST /v1/support/bugs': { limit: 5, windowSeconds: 60, key: 'ip' },
    'POST /v1/support/grievances': { limit: 5, windowSeconds: 60, key: 'ip' },
    // Routes the old build left un-limited — fresh build MUST limit them:
    'GET /v1/rooms/:id': { limit: 60, windowSeconds: 60, key: 'seat' },
    // Config: the host client debounces at 500 ms while dragging steppers,
    // so sustained editing legitimately sends up to 120/min/seat. The
    // limit matches that debounce exactly (120/min/seat) — a host-only,
    // host-token-authed, lobby-only full replace, still bounded, still
    // validated in the DO. Raising the number to match the client is the
    // consistency fix; the protection (per-seat bucket + DO validation)
    // is unchanged.
    'POST /v1/rooms/:id/config': { limit: 120, windowSeconds: 60, key: 'seat' },
    'POST /v1/rooms/:id/remove-player': { limit: 10, windowSeconds: 60, key: 'seat' },
    'POST /v1/rooms/:id/regenerate-code': { limit: 5, windowSeconds: 60, key: 'seat' },
    'POST /v1/rooms/:id/catch-token': { limit: 10, windowSeconds: 60, key: 'seat' },
    'POST /v1/rooms/:id/lifecycle': { limit: 10, windowSeconds: 60, key: 'seat' },
    'POST /v1/rooms/:id/host/token': { limit: 5, windowSeconds: 60, key: 'seat' },
    'POST /v1/rooms/:id/host/transfer': { limit: 5, windowSeconds: 60, key: 'seat' },
    'POST /v1/rooms/:id/catches/:cid/resolve': { limit: 10, windowSeconds: 60, key: 'seat' },
    'GET /v1/rooms/:id/results': { limit: 30, windowSeconds: 60, key: 'seat' },
    // The WS upgrade is keyed by ROOM, not client IP: 30 players on one
    // venue WiFi share one IP, and a per-IP cap would 429 the 6th player.
    // 60/min per room covers a full roster connecting + retries. The
    // Worker builds the key from the roomId (see workers/src/index.ts).
    'WS /v1/rooms/:id/ws': { limit: 60, windowSeconds: 60, key: 'room' },
  } as const;

/**
 * The OPEN calibration values, grouped, so a field-measurement pass can find
 * them all in one place. These are placeholders, not requirements.
 */
export const CALIBRATION_OPEN = {
  accuracyGoodM: ACCURACY_GOOD_M,
  accuracyFairM: ACCURACY_FAIR_M,
  accuracyPoorM: ACCURACY_POOR_M,
  catchProximityPlausibilityM: CATCH_PROXIMITY_PLAUSIBILITY_M,
  catchTokenTtlSeconds: CATCH_TOKEN_TTL_SECONDS,
  pingIntervalSecondsDefault: PING_INTERVAL_SECONDS_DEFAULT,
  pingAccelerationSeconds: PING_ACCELERATION_SECONDS,
  disconnectGraceSeconds: DISCONNECT_GRACE_SECONDS,
  suspensionFreshnessSeconds: SUSPENSION_FRESHNESS_SECONDS,
  locationFreshnessSeconds: LOCATION_FRESHNESS_SECONDS,
  suspensionsBeforeHostCheckin: SUSPENSIONS_BEFORE_HOST_CHECKIN,
  pendingPingTtlSeconds: PENDING_PING_TTL_SECONDS,
  quickPresetDurationSeconds: QUICK_PRESET_DURATION_SECONDS,
  headStartSecondsDefault: HEAD_START_SECONDS_DEFAULT,
  standardDurationSeconds: STANDARD_DURATION_SECONDS,
  zoneShrinkIntervalSecondsDefault: ZONE_SHRINK_INTERVAL_SECONDS_DEFAULT,
  pingAreaRadiusM: PING_AREA_RADIUS_M,
  clockSkewMs: CLOCK_SKEW_MS,
  staleFixMs: STALE_FIX_MS,
  maxPlausibleSpeedMps: MAX_PLAUSIBLE_SPEED_MPS,
  wsTicketTtlMs: WS_TICKET_TTL_MS,
  reconnectMaxAttempts: RECONNECT_MAX_ATTEMPTS,
  reconnectBackoffBaseMs: RECONNECT_BACKOFF_BASE_MS,
  reconnectBackoffCeilingMs: RECONNECT_BACKOFF_CEILING_MS,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  heartbeatMissedLimit: HEARTBEAT_MISSED_LIMIT,
  balancedHunterTable: BALANCED_HUNTER_TABLE,
  wsMessageRateLimits: WS_MESSAGE_RATE_LIMITS,
  httpRateLimits: HTTP_RATE_LIMITS,
} as const;
