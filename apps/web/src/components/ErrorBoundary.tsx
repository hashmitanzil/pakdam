/**
 * ErrorBoundary — reliability spec Gap 3 (§4).
 *
 * A crash in the map, the radio, or the catch screen degrades to a
 * fallback for that component ONLY — the rest of the HUD keeps
 * working — and files ONE bug report through the existing path
 * (`POST /v1/support/bugs` via `getWorkerUrl()` — never a Next.js
 * API route; the web app has none). No Sentry, no new service.
 *
 * Reporting (the endpoint's own rules):
 * - `description`: `ErrorBoundary[<kind>]: <message>` + the component
 *   stack, truncated so the whole field stays under 5000 chars.
 * - `deviceInfo`: `navigator.userAgent`, ≤ 500 chars.
 * - `roomId` / `playerId`: from props (both optional at the endpoint).
 * - NEVER attach location: no fix, no zone, no coordinates anywhere
 *   in the description. The description is built only from the error
 *   message + the React component stack (component names, never data).
 * - Once per mount per error. A failed report never throws inside the
 *   boundary and is never retried in a loop (fire-and-forget, all
 *   failures swallowed; the report flag is set BEFORE the fetch).
 * - No Worker URL (demo mode) → no report is attempted at all.
 *
 * Fallbacks are plain words, never a raw stack trace:
 * - map: "The map failed to load." + Retry (remounts the child) + the
 *   game-still-running line + "Reload game".
 * - radio: "Radio is unavailable right now." + "Reload game".
 * - catch: "The catch screen failed." + back-to-play + "Reload game".
 *
 * Wrap order (spec §4): <PlayMap> and <RadioStrip> on the play page,
 * <CatchQR> on the catch page. StatusStrip / PlayerDots / PTT stay
 * OUTSIDE the boundary in v1, so a boundary bug cannot take the HUD.
 */
'use client';

import { Component, Fragment, type ReactNode } from 'react';
import { getWorkerUrl } from '@/lib/websocket';

export type ErrorBoundaryKind = 'map' | 'radio' | 'catch';

export interface ErrorBoundaryProps {
  kind: ErrorBoundaryKind;
  roomId?: string;
  playerId?: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  retryNonce: number;
}

const DESCRIPTION_MAX_CHARS = 5000;
const DEVICE_INFO_MAX_CHARS = 500;

/**
 * TEST-ONLY override for the bug-report URL (`e2e/error-boundary.spec.ts`
 * sets `window.__pakdamTestWorkerUrl` via `addInitScript` so the mocked
 * `POST /v1/support/bugs` can be observed in demo mode, where no Worker
 * URL is configured). Never set in production; ignored unless it is an
 * http(s) URL. Production behaviour is unchanged: the report goes to the
 * Worker via `getWorkerUrl()`.
 */
function testWorkerUrlOverride(): string {
  try {
    if (typeof window === 'undefined') return '';
    const value = (window as unknown as { __pakdamTestWorkerUrl?: unknown })
      .__pakdamTestWorkerUrl;
    return typeof value === 'string' && /^https?:\/\//.test(value)
      ? value.replace(/\/+$/, '')
      : '';
  } catch {
    return '';
  }
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, retryNonce: 0 };
  /** The error already reported for this mount (guard against a reporting loop). */
  private reportedError: Error | null = null;

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    if (this.reportedError === error) return;
    this.reportedError = error;
    void this.reportBug(error, info.componentStack ?? '');
  }

  /**
   * One bug report, fire-and-forget. NEVER throws: every failure path
   * is swallowed, and the flag above is set before the fetch starts,
   * so a failing report can neither crash the boundary nor re-report.
   */
  private async reportBug(error: Error, componentStack: string): Promise<void> {
    try {
      const workerUrl = getWorkerUrl() || testWorkerUrlOverride();
      if (!workerUrl) return;
      const header = `ErrorBoundary[${this.props.kind}]: ${error.message}`;
      const body = `${header}\n${componentStack}`.slice(0, DESCRIPTION_MAX_CHARS);
      const deviceInfo =
        typeof navigator !== 'undefined'
          ? navigator.userAgent.slice(0, DEVICE_INFO_MAX_CHARS)
          : undefined;
      await fetch(`${workerUrl}/v1/support/bugs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: body,
          ...(deviceInfo ? { deviceInfo } : {}),
          ...(this.props.roomId ? { roomId: this.props.roomId } : {}),
          ...(this.props.playerId ? { playerId: this.props.playerId } : {}),
        }),
      });
    } catch {
      // A failed report is silent by design — never a throw, never a retry.
    }
  }

  private handleRetry = (): void => {
    this.reportedError = null;
    this.setState((prev) => ({ error: null, retryNonce: prev.retryNonce + 1 }));
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      // Key change remounts the child on Retry (map) without adding a
      // DOM wrapper — PlayMap sizes itself with h-full, so a wrapping
      // div would collapse it.
      return <Fragment key={this.state.retryNonce}>{this.props.children}</Fragment>;
    }
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-[#26262B] bg-[#141416] p-6 text-center">
        {this.props.kind === 'map' ? (
          <>
            <p className="text-[15px] font-bold text-white">The map failed to load.</p>
            <p className="text-[14px] text-[#A1A1AA]">
              The game itself is still running — your position, pings and radio are unaffected.
            </p>
            <button
              type="button"
              onClick={this.handleRetry}
              className="mt-1 rounded-full bg-white px-4 py-2 text-[14px] font-bold text-black"
            >
              Retry map
            </button>
          </>
        ) : this.props.kind === 'radio' ? (
          <>
            <p className="text-[15px] font-bold text-white">Radio is unavailable right now.</p>
            <p className="text-[14px] text-[#A1A1AA]">
              The game continues without radio — the map and your position are unaffected.
            </p>
          </>
        ) : (
          <>
            <p className="text-[15px] font-bold text-white">The catch screen failed.</p>
            {this.props.roomId ? (
              <a
                href={`/room/${this.props.roomId}/play`}
                className="mt-1 rounded-full bg-white px-4 py-2 text-[14px] font-bold text-black"
              >
                Back to the map
              </a>
            ) : null}
          </>
        )}
        <button
          type="button"
          onClick={this.handleReload}
          className="text-[15px] font-semibold text-[#EF4444]"
        >
          Reload game
        </button>
      </div>
    );
  }
}
