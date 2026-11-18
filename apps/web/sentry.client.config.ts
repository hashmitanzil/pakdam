// Sentry — browser errors only. The DSN guard means the file is
// inert until NEXT_PUBLIC_SENTRY_DSN is set; with no DSN, Sentry
// never initialises and errors stay local.
import * as Sentry from '@sentry/nextjs';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    // Error monitoring only: no performance tracing, so the free
    // allowance is spent on errors, not on transaction volume.
    tracesSampleRate: 0,
    // Never send personally identifiable information by default.
    sendDefaultPii: false,
  });
}
