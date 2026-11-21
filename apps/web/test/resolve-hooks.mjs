/**
 * ESM resolve hook for these unit tests only (mirrors
 * workers/resolve-hooks.mjs).
 *
 * Plain Node cannot run this repo's TypeScript sources as-is: the web
 * sources import each other extensionless (bundler-style,
 * `moduleResolution: "bundler"`), and `@pakdam/shared` resolves to
 * `src/index.ts`. This hook rewrites, for test files only:
 *  - `@pakdam/shared` -> the shared package's `src/index.ts`
 *  - `@pakdam/engine` -> the engine package's `src/index.ts`
 *  - a relative `./x` / `../x` -> `./x.ts` / `../x.ts` when that file
 *    exists (extensionless, bundler-style)
 *  - a relative `./x.js` / `../x.js` -> `./x.ts` / `../x.ts` when that
 *    file exists (type-only imports are erased by Node's type stripping
 *    and never reach the resolver)
 * Everything else falls through to Node's default resolver. No production
 * code is touched; the hook is only registered by files under `test/`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHARED_INDEX_URL = new URL(
  '../../../packages/shared/src/index.ts',
  import.meta.url,
).href;

const ENGINE_INDEX_URL = new URL(
  '../../../packages/engine/src/index.ts',
  import.meta.url,
).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@pakdam/shared') {
    return { url: SHARED_INDEX_URL, shortCircuit: true };
  }
  if (specifier === '@pakdam/engine') {
    return { url: ENGINE_INDEX_URL, shortCircuit: true };
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    try {
      const resolved = new URL(specifier, context.parentURL);
      if (resolved.protocol === 'file:') {
        if (resolved.pathname.endsWith('.js')) {
          const tsUrl = new URL(resolved.href.replace(/\.js$/, '.ts'));
          if (existsSync(fileURLToPath(tsUrl))) {
            return { url: tsUrl.href, shortCircuit: true };
          }
        } else if (!/\.[a-zA-Z0-9]+$/.test(resolved.pathname)) {
          const tsUrl = new URL(`${resolved.href}.ts`);
          if (existsSync(fileURLToPath(tsUrl))) {
            return { url: tsUrl.href, shortCircuit: true };
          }
        }
      }
    } catch {
      // Fall through to the default resolver.
    }
  }
  return nextResolve(specifier, context);
}
