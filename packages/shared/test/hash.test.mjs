import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

register('../resolve-hooks.mjs', import.meta.url);

const {
  sha256Hex,
  hashToken,
  catchTokenHash,
  isSha256Hex,
  randomHex,
  newCatchToken,
  newId,
} = await import('../src/hash.ts');
const { isUuid } = await import('../src/validation.ts');

test('sha256Hex: known vectors (empty string and "abc")', async () => {
  assert.equal(
    await sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('sha256Hex: always 64 lowercase hex chars', async () => {
  const digest = await sha256Hex('pakdam');
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(isSha256Hex(digest), true);
});

test('hashToken: same input, same hash; different input, different hash', async () => {
  assert.equal(await hashToken('ticket-1'), await sha256Hex('ticket-1'));
  assert.notEqual(await hashToken('ticket-1'), await hashToken('ticket-2'));
});

test('catchTokenHash: deterministic, and bound to both catchId and token', async () => {
  const a = await catchTokenHash('catch-1', 'TOKEN');
  assert.equal(a, await catchTokenHash('catch-1', 'TOKEN'));
  assert.notEqual(a, await catchTokenHash('catch-2', 'TOKEN'));
  assert.notEqual(a, await catchTokenHash('catch-1', 'OTHER'));
  assert.equal(isSha256Hex(a), true);
});

test('isSha256Hex: only 64 lowercase hex chars pass', () => {
  assert.equal(isSha256Hex('0'.repeat(64)), true);
  assert.equal(isSha256Hex('A'.repeat(64)), false);
  assert.equal(isSha256Hex('0'.repeat(63)), false);
  assert.equal(isSha256Hex('0'.repeat(65)), false);
  assert.equal(isSha256Hex(123), false);
});

test('randomHex: length is 2× bytes, lowercase hex, never repeats', () => {
  const hex = randomHex(16);
  assert.equal(hex.length, 32);
  assert.match(hex, /^[0-9a-f]{32}$/);
  assert.notEqual(hex, randomHex(16));
  assert.throws(() => randomHex(0), /positive integer/);
  assert.throws(() => randomHex(-1), /positive integer/);
  assert.throws(() => randomHex(1.5), /positive integer/);
});

test('newCatchToken: 32 uppercase hex chars (128 bits), never repeats', () => {
  const token = newCatchToken();
  assert.equal(token.length, 32);
  assert.match(token, /^[0-9A-F]{32}$/);
  assert.notEqual(token, newCatchToken());
});

test('newId: produces a valid UUID', () => {
  assert.equal(isUuid(newId()), true);
});
