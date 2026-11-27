import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const {
  ADMIN_LOGIN_ATTEMPT_LIMIT,
  ADMIN_LOGIN_LOCKOUT_MS,
  ADMIN_MIN_PASSWORD_LENGTH,
  ADMIN_PBKDF2_ITERATIONS,
  ADMIN_SESSION_TTL_MS,
  hashAdminPassword,
  isAdminDevMode,
  isPairLocked,
  isSessionExpired,
  isValidAdminPassword,
  mintAdminToken,
  nextPairLoginState,
  parseAdminToken,
  timingSafeEqual,
  verifyAdminPassword,
  verifyAdminTokenSignature,
} = await import('../src/admin-auth.ts');

// PBKDF2-SHA256, 600,000 iterations (OWASP 2023). Each hash/verify
// costs a few hundred ms of CPU — the tests below keep the count
// small on purpose (1 mint + 3 verifies + 1 tamper).

test('hash + verify round-trips; wrong password fails; malformed hash fails', async () => {
  const stored = await hashAdminPassword('correct horse battery staple');
  assert.match(stored, new RegExp(`^pbkdf2-sha256\\$${ADMIN_PBKDF2_ITERATIONS}\\$`));
  assert.equal(await verifyAdminPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyAdminPassword('wrong password', stored), false);
  assert.equal(await verifyAdminPassword('correct horse battery staple', 'not-a-hash'), false);
  assert.equal(await verifyAdminPassword('correct horse battery staple', 'pbkdf2-sha256$1$AAAA$AAAA'), false);
});

test('same password hashes differently per user (random salt)', async () => {
  const a = await hashAdminPassword('same-password-123');
  const b = await hashAdminPassword('same-password-123');
  assert.notEqual(a, b);
  assert.equal(await verifyAdminPassword('same-password-123', a), true);
  assert.equal(await verifyAdminPassword('same-password-123', b), true);
});

test('password policy: 12+ characters (fix round n6)', () => {
  assert.equal(ADMIN_MIN_PASSWORD_LENGTH, 12);
  assert.equal(isValidAdminPassword('short'), false);
  assert.equal(isValidAdminPassword('eleven-char'), false);
  assert.equal(isValidAdminPassword('twelve-chars!'), true);
});

test('session token: mint → parse → HMAC verify; tampered signature fails', async () => {
  const secret = 'test-admin-session-secret';
  const minted = await mintAdminToken('11111111-2222-4333-8444-555555555555', secret);
  assert.match(minted.token, /^v1\.[0-9a-f-]+\.[0-9a-f]{64}\.[0-9a-f]{64}$/);
  assert.equal(minted.tokenHash.length, 64);
  assert.notEqual(minted.token, minted.tokenHash, 'the raw token is never its own hash');
  const parsed = parseAdminToken(minted.token);
  assert.ok(parsed);
  assert.equal(parsed.sessionId, '11111111-2222-4333-8444-555555555555');
  assert.equal(await verifyAdminTokenSignature(minted.token, secret), true);
  // Flip one hex char of the signature.
  const tampered = `${minted.token.slice(0, -1)}${minted.token.endsWith('0') ? '1' : '0'}`;
  assert.equal(await verifyAdminTokenSignature(tampered, secret), false);
  assert.equal(await verifyAdminTokenSignature(minted.token, 'a-different-secret'), false);
  assert.equal(parseAdminToken('garbage'), null);
});

test('timingSafeEqual: equal strings verify; same-length differ fails; different lengths fail without throwing (fix round hardening)', () => {
  assert.equal(timingSafeEqual('founder-secret', 'founder-secret'), true);
  assert.equal(timingSafeEqual('founder-secret', 'founder-secrex'), false, 'one differing char fails');
  assert.equal(timingSafeEqual('founder-secret', 'x'), false, 'a shorter string fails, never throws');
  assert.equal(timingSafeEqual('founder-secret', 'founder-secret-but-longer-and-wrong'), false, 'a longer string fails, never throws');
  assert.equal(timingSafeEqual('', ''), true);
  assert.equal(timingSafeEqual('', 'x'), false);
});

test('fail-closed secret: minting without a secret throws unless dev mode is explicit; nosecret verifies only in dev mode', async () => {
  // No secret, no dev mode → mint throws (the handlers answer 503
  // before ever reaching this; the throw is the backstop).
  await assert.rejects(
    () => mintAdminToken('11111111-2222-4333-8444-555555555555'),
    /ADMIN_SESSION_SECRET/,
    'minting without a secret and without dev mode must throw',
  );
  assert.equal(isAdminDevMode({}), false);
  assert.equal(isAdminDevMode({ ADMIN_DEV_MODE: 'true' }), true);
  assert.equal(isAdminDevMode({ ADMIN_DEV_MODE: 'false' }), false);
  // Dev mode on: nosecret mint + verify work.
  const minted = await mintAdminToken('11111111-2222-4333-8444-555555555555', undefined, true);
  assert.ok(minted.token.endsWith('.nosecret'));
  assert.equal(await verifyAdminTokenSignature(minted.token, undefined, true), true);
  // The same token does NOT verify when dev mode is off (production).
  assert.equal(await verifyAdminTokenSignature(minted.token, undefined, false), false);
  // And a nosecret token never verifies against a real secret.
  assert.equal(await verifyAdminTokenSignature(minted.token, 'some-secret'), false);
});

test('per-pair lockout: 5th failure from one pair arms a 15-minute lock for THAT pair; a stale lock is not a lock', () => {
  const now = Date.now();
  assert.equal(ADMIN_LOGIN_ATTEMPT_LIMIT, 5);
  assert.equal(ADMIN_LOGIN_LOCKOUT_MS, 15 * 60 * 1000);
  assert.equal(isPairLocked(4, null, now), false);
  assert.equal(isPairLocked(5, null, now), false);
  const locked = nextPairLoginState(4, now);
  assert.equal(locked.failedAttempts, 5);
  assert.ok(locked.lockedUntil);
  assert.equal(Date.parse(locked.lockedUntil) - now, ADMIN_LOGIN_LOCKOUT_MS);
  assert.equal(isPairLocked(5, locked.lockedUntil, now), true);
  assert.equal(isPairLocked(5, locked.lockedUntil, now + ADMIN_LOGIN_LOCKOUT_MS + 1000), false);
  const early = nextPairLoginState(2, now);
  assert.deepEqual(early, { failedAttempts: 3, lockedUntil: null });
});

test('session expiry: 12 h absolute', () => {
  assert.equal(ADMIN_SESSION_TTL_MS, 12 * 60 * 60 * 1000);
  const now = Date.now();
  assert.equal(isSessionExpired(new Date(now + 60_000).toISOString(), now), false);
  assert.equal(isSessionExpired(new Date(now - 1000).toISOString(), now), true);
});
