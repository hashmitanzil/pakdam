/**
 * ESM resolve hook for these unit tests only.
 *
 * Plain Node cannot run this repo's TypeScript sources as-is: the sources
 * import each other with `.js` specifiers (bundler-style, `moduleResolution:
 * "bundler"`), and `@pakdam/shared` resolves to `src/index.ts`. This hook
 * rewrites, for test files only:
 *  - `@pakdam/shared` -> this package's shared `src/index.ts`
 *  - a relative `./x.js` / `../x.js` -> `./x.ts` / `../x.ts` when that file
 *    exists (type-only imports are erased by Node's type stripping and
 *    never reach the resolver)
 * Everything else falls through to Node's default resolver. No production
 * code is touched; the hook is only registered by files under `test/`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHARED_INDEX_URL = new URL('./src/index.ts', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@pakdam/shared') {
    return { url: SHARED_INDEX_URL, shortCircuit: true };
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    try {
      const resolved = new URL(specifier, context.parentURL);
      if (resolved.protocol === 'file:' && resolved.pathname.endsWith('.js')) {
        const tsUrl = new URL(resolved.href.replace(/\.js$/, '.ts'));
        if (existsSync(fileURLToPath(tsUrl))) {
          return { url: tsUrl.href, shortCircuit: true };
        }
      }
    } catch {
      // Fall through to the default resolver.
    }
  }
  return nextResolve(specifier, context);
}
