/**
 * v36 status-name pin (Kabir) — the waiting-line cluster: 5 of the 7
 * v35-push CI failures, all `getByRole('status', { name: WAITING_LINE })`
 * — element(s) NOT FOUND, 10 s timeout (host-grace :157/:189/:247/:299,
 * host-cancel-room-deleted :314).
 *
 * MECHANISM (proven, not assumed) — WAI-ARIA 1.2 (W3C Recommendation),
 * `status` role characteristics table:
 *   | Name From: | author |
 * and §5.2.8: `author` means the name comes ONLY from values provided
 * by the author in explicit markup — `aria-label`, `aria-labelledby`,
 * or a host-language labelling mechanism. `contents` (name from the
 * text value of the element) is a DIFFERENT value, and `status` does
 * not have it. So a bare `<p role="status">Waiting for the host to
 * reconnect…</p>` has an EMPTY accessible name, and Playwright's
 * `getByRole('status', { name: ... })` — which matches on the
 * accessible name — can NEVER match it, however visible the text is.
 * The element is present; it is unnamed. That is exactly the CI
 * symptom ("element(s) not found"), and it is also why the failure is
 * identical in lobby and play: both sites had the label stripped.
 *
 * CORRECTION, recorded explicitly: Diya round 3's falsification was
 * itself wrong. The reasoning was that the label is byte-identical to
 * the visible text and therefore a no-op. It is not a no-op: for
 * role=status the label IS the only name source, so the byte-identical
 * label is load-bearing. Three-run correlation confirms it — v33 (no
 * labels) FAILED these tests with this exact symptom, v34 (labels)
 * PASSED them, v35 (labels removed) FAILS them again. Do NOT re-remove
 * these labels; this file is the pin that stops the next round doing so.
 *
 * The v34 form restored here (recovered verbatim from
 * ~/workspace/your_files/pakdam-fresh-v34.zip):
 *   <p … role="status" aria-label="Waiting for the host to reconnect…">
 *     Waiting for the host to reconnect…
 *   </p>
 * on BOTH sites (lobby page.tsx, play page.tsx).
 *
 * Source pins, not behaviour proofs — only founder CI proves the flows
 * end to end. But the pin captures the real CI condition: the name the
 * e2e locator asks for must exist as an author-provided name on the
 * same element as role="status".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function readSrc(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

const WAITING_LINE = 'Waiting for the host to reconnect…';
const DELETED_MESSAGE = 'The host cancelled — this lobby is gone.';

/**
 * The opening tag of the element whose visible text is `text` must
 * carry BOTH role="status" AND aria-label="<text>" — the label on the
 * SAME element, not merely somewhere in the file. A label elsewhere
 * does not name this element.
 */
function assertStatusNamed(src, file, text) {
  // Find the VISIBLE text occurrence, not the aria-label value itself:
  // the label string occurs twice (attribute + content); the content
  // occurrence is the one NOT immediately preceded by `aria-label="`.
  let at = -1;
  let from = 0;
  for (;;) {
    const next = src.indexOf(text, from);
    assert.ok(next > -1, `${file} must render the line ${JSON.stringify(text)}`);
    if (!src.slice(Math.max(0, next - 12), next).endsWith('aria-label="')) {
      at = next;
      break;
    }
    from = next + text.length;
  }
  const window = src.slice(Math.max(0, at - 500), at);
  assert.ok(
    window.includes('role="status"'),
    `${file}: the ${JSON.stringify(text)} line must sit in a role="status" element`,
  );
  assert.ok(
    window.includes(`aria-label="${text}"`),
    `${file}: the role="status" element for ${JSON.stringify(text)} must carry aria-label="${text}" on the SAME element — ` +
      `WAI-ARIA 1.2: status Name From is author-only, so without the label its accessible name is EMPTY and ` +
      `getByRole('status', { name: ... }) can never match it (v35 CI: element(s) not found). Do NOT remove this label.`,
  );
}

test('v36 status-name: the lobby waiting line carries its aria-label on the role=status element', () => {
  const lobby = readSrc('src/app/room/[roomId]/page.tsx');
  assertStatusNamed(lobby, 'lobby page.tsx', WAITING_LINE);
});

test('v36 status-name: the play waiting line carries its aria-label on the role=status element', () => {
  const play = readSrc('src/app/room/[roomId]/play/page.tsx');
  assertStatusNamed(play, 'play page.tsx', WAITING_LINE);
});

test('v36 status-name: the home room-deleted notice keeps its aria-label (host-rules:41)', () => {
  // host-rules.spec.ts:41 looks up getByRole('status', { name: DELETED_MESSAGE }).
  // Same rule applies: the home notice is role=status, so it needs the
  // author-provided name. It was never stripped (aria-label={ROOM_DELETED_MESSAGE}),
  // and this pins it so it is never stripped the way the waiting line was.
  const home = readSrc('src/app/page.tsx');
  const at = home.indexOf('aria-label={ROOM_DELETED_MESSAGE}');
  assert.ok(at > -1, 'home page.tsx must keep aria-label={ROOM_DELETED_MESSAGE}');
  const window = home.slice(Math.max(0, at - 500), at);
  assert.ok(
    window.includes('role="status"'),
    'home page.tsx: the deleted notice aria-label must sit on the role="status" element',
  );
  const deleted = readSrc('src/lib/room-deleted.ts');
  assert.ok(
    deleted.includes(`ROOM_DELETED_MESSAGE = '${DELETED_MESSAGE}'`),
    'lib/room-deleted.ts: ROOM_DELETED_MESSAGE must stay the exact DELETED_MESSAGE string',
  );
});

test('v36 status-name: the e2e name constants match the aria-labels exactly (no drift)', () => {
  // If a spec const drifts from the label by even the ellipsis char,
  // getByRole name matching fails the same way the v35 CI did.
  for (const spec of ['e2e/host-grace.spec.ts', 'e2e/host-cancel-room-deleted.spec.ts']) {
    const src = readSrc(spec);
    assert.ok(
      src.includes(`const WAITING_LINE = '${WAITING_LINE}';`),
      `${spec}: WAITING_LINE must stay exactly '${WAITING_LINE}'`,
    );
  }
  const rules = readSrc('e2e/host-rules.spec.ts');
  assert.ok(
    rules.includes(`const DELETED_MESSAGE = '${DELETED_MESSAGE}';`),
    `host-rules.spec.ts: DELETED_MESSAGE must stay exactly '${DELETED_MESSAGE}'`,
  );
});

test('v36 status-name: every getByRole(status) name lookup in e2e resolves to a labelled element', () => {
  // Exhaustive sweep of the lookup side: the only names ever asked for
  // under role=status are WAITING_LINE and DELETED_MESSAGE, and both
  // are pinned above. If a new lookup appears, this test must be
  // extended with its element — a name lookup against an unlabelled
  // role=status is a guaranteed CI failure, not a flake.
  const known = new Set([WAITING_LINE, DELETED_MESSAGE]);
  for (const spec of ['e2e/host-grace.spec.ts', 'e2e/host-cancel-room-deleted.spec.ts', 'e2e/host-rules.spec.ts']) {
    const src = readSrc(spec);
    const names = [...src.matchAll(/getByRole\('status',\s*\{\s*name:\s*([A-Z_]+)\s*\}\)/g)].map(
      (m) => m[1],
    );
    assert.ok(names.length > 0, `${spec}: expected at least one getByRole('status') lookup`);
    for (const name of names) {
      const value =
        name === 'WAITING_LINE' ? WAITING_LINE : name === 'DELETED_MESSAGE' ? DELETED_MESSAGE : null;
      assert.ok(
        value !== null && known.has(value),
        `${spec}: getByRole('status', { name: ${name} }) has no pinned labelled element — ` +
          `status is Name From: author, so an unlabelled target can never match`,
      );
    }
  }
});
