import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const {
  issueRunnerQrToken,
  isRunnerQrTokenExpired,
  resolveRunnerQrToken,
  CATCH_TOKEN_TTL_SECONDS,
} = await import('../src/catch.ts');
const { isValidCatchToken, isSha256Hex, runnerTokenHash } = await import('@pakdam/shared');

const NOW = 1_000_000;
const RUNNER = 'runner-1';
const OTHER = 'runner-2';

test('runner token: mint is 128-bit, hash-only, TTL 120 s', async () => {
  assert.equal(CATCH_TOKEN_TTL_SECONDS, 120);
  const { token, record } = await issueRunnerQrToken(RUNNER, NOW);
  assert.equal(isValidCatchToken(token), true, 'token must be 32 uppercase hex');
  assert.equal(token.length, 32);
  assert.equal(record.runnerPlayerId, RUNNER);
  assert.equal(record.used, false);
  assert.equal(record.issuedAtMs, NOW);
  assert.equal(record.expiresAtMs, NOW + 120_000);
  assert.equal(isSha256Hex(record.tokenHash), true, 'stored hash must be SHA-256 hex');
  assert.equal('token' in record, false, 'the record must never carry the raw value');
  assert.equal(JSON.stringify(record).includes(token), false, 'the raw must not leak into the record JSON');
  assert.equal(
    record.tokenHash,
    await runnerTokenHash(RUNNER, token),
    'the hash must be sha256(runner:runnerId:raw)',
  );
});

test('runner token: resolves the Runner from the raw value alone', async () => {
  const { token, record } = await issueRunnerQrToken(RUNNER, NOW);
  const other = await issueRunnerQrToken(OTHER, NOW);
  const found = await resolveRunnerQrToken([record, other.record], token, NOW + 1000);
  assert.equal(found.status, 'valid');
  assert.equal(found.record?.runnerPlayerId, RUNNER);
});

test('runner token: a runner token never verifies as another Runner, and the hash domain differs from a claim token', async () => {
  const { token, record } = await issueRunnerQrToken(RUNNER, NOW);
  // Same raw value hashed under the claim domain is a different digest.
  const { catchTokenHash } = await import('@pakdam/shared');
  assert.notEqual(record.tokenHash, await catchTokenHash('some-catch-id', token));
  // A record for another Runner does not match this token.
  const other = await issueRunnerQrToken(OTHER, NOW);
  const found = await resolveRunnerQrToken([other.record], token, NOW + 1000);
  assert.equal(found.status, 'unknown');
  assert.equal(found.record, null);
});

test('runner token: unknown / malformed tokens resolve unknown without hashing', async () => {
  const { record } = await issueRunnerQrToken(RUNNER, NOW);
  const unknown = await resolveRunnerQrToken([record], 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', NOW);
  assert.equal(unknown.status, 'unknown');
  const malformed = await resolveRunnerQrToken([record], 'short', NOW);
  assert.equal(malformed.status, 'unknown');
  const lower = await resolveRunnerQrToken([record], 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NOW);
  assert.equal(lower.status, 'unknown', 'lowercase is not a valid token');
});

test('runner token: expired at exactly TTL, live one ms before', async () => {
  const { token, record } = await issueRunnerQrToken(RUNNER, NOW);
  assert.equal(isRunnerQrTokenExpired(record, NOW + 119_999), false);
  assert.equal(isRunnerQrTokenExpired(record, NOW + 120_000), true);
  const live = await resolveRunnerQrToken([record], token, NOW + 119_999);
  assert.equal(live.status, 'valid');
  const dead = await resolveRunnerQrToken([record], token, NOW + 120_000);
  assert.equal(dead.status, 'expired');
  assert.equal(dead.record?.runnerPlayerId, RUNNER, 'an expired QR still names its Runner');
});

test('runner token: a used token resolves used, never valid again', async () => {
  const { token, record } = await issueRunnerQrToken(RUNNER, NOW);
  record.used = true;
  const found = await resolveRunnerQrToken([record], token, NOW + 1000);
  assert.equal(found.status, 'used');
});

test('runner token: two mints for the same Runner give different tokens (re-mint rotates)', async () => {
  const first = await issueRunnerQrToken(RUNNER, NOW);
  const second = await issueRunnerQrToken(RUNNER, NOW + 5000);
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.record.tokenHash, second.record.tokenHash);
});
