/** HNT-115: counts only. NO raw location, NO coordinates, NO player trails,
 *  NO ticket/token values — ticket events are counted by outcome only. */
export interface TelemetryCounts {
  matchesCompleted: number; locationUpdates: number; wsMessages: number; errors: number;
  wsTicketsIssued: number; wsTicketsReused: number; wsTicketsInvalid: number;
  wsHelloRejected: number; wsSnapshotsSent: number; wsReconnects: number;
  wsHeartbeatsMissed: number;
}
export function emptyTelemetry(): TelemetryCounts {
  return {
    matchesCompleted: 0, locationUpdates: 0, wsMessages: 0, errors: 0,
    wsTicketsIssued: 0, wsTicketsReused: 0, wsTicketsInvalid: 0,
    wsHelloRejected: 0, wsSnapshotsSent: 0, wsReconnects: 0,
    wsHeartbeatsMissed: 0,
  };
}
export type TelemetryWsEvent =
  | 'ticket-issued' | 'ticket-reused' | 'ticket-invalid'
  | 'hello-rejected' | 'snapshot-sent' | 'reconnect' | 'heartbeat-missed';
/** Count one WS protocol event. Counts only — no payload, no identifier. */
export function countWsEvent(counts: TelemetryCounts, event: TelemetryWsEvent): TelemetryCounts {
  switch (event) {
    case 'ticket-issued': return { ...counts, wsTicketsIssued: counts.wsTicketsIssued + 1 };
    case 'ticket-reused': return { ...counts, wsTicketsReused: counts.wsTicketsReused + 1 };
    case 'ticket-invalid': return { ...counts, wsTicketsInvalid: counts.wsTicketsInvalid + 1 };
    case 'hello-rejected': return { ...counts, wsHelloRejected: counts.wsHelloRejected + 1 };
    case 'snapshot-sent': return { ...counts, wsSnapshotsSent: counts.wsSnapshotsSent + 1 };
    case 'reconnect': return { ...counts, wsReconnects: counts.wsReconnects + 1 };
    case 'heartbeat-missed': return { ...counts, wsHeartbeatsMissed: counts.wsHeartbeatsMissed + 1 };
  }
}
