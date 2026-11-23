/**
 * ErrorBoundaryThrowTest — TEST-ONLY component for the error-boundary
 * e2e spec (`e2e/error-boundary.spec.ts`).
 *
 * Throws during render so the boundary's fallback + bug report can be
 * asserted. Rendered ONLY behind the `?errorBoundaryTest=<kind>` query
 * param on the play / catch pages — never in normal use, never by any
 * real user flow. No UI, no props that matter, no production behaviour.
 */
export function ErrorBoundaryThrowTest(): never {
  throw new Error('Test error for the error boundary.');
}
