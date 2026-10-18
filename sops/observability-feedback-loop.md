# SOP: Observability & Health Feedback Loop

> Standard Operating Procedure for structured logging, metric tracking, error detection, and continuous health verification in Agora.

## 1. Principles
High-concurrency presentation environments require granular real-time visibility into slide transitions, connection counts, WebSocket latency, and database errors.

## 2. Observability Vectors

### 1. Structured Logging
All Worker and Durable Object logs are output as single-line JSON objects with standard fields:
```json
{
  "timestamp": "2026-10-18T20:44:00.000Z",
  "level": "info",
  "context": "SessionDurableObject",
  "sessionId": "sess_123",
  "event": "slide.transition",
  "slideId": "slide_4",
  "connectedClients": 420,
  "durationMs": 4.2
}
```

### 2. Session Metrics
Track the following metrics inside each active `SessionDurableObject`:
- `active_websocket_connections`: Current live sockets.
- `slide_transition_latency_ms`: Time from receiving `slide.changed` to broadcasting to all hibernated sockets.
- `questions_total`: Cumulative questions submitted.
- `reactions_rate_per_sec`: Inflow rate of attendee emojis.
- `sqlite_exec_duration_ms`: Duration of SQLite statements.

### 3. Alarm & Anomaly Thresholds
- **Slide Sync Latency > 500ms**: Trigger warning log and investigate WebSocket broadcast chunking.
- **Reactions Surge > 1,000/sec**: Verify batch aggregation loop is collapsing deltas to 500ms intervals.
- **SQLite Error Rate > 0.1%**: Check for database lock contention or constraint violations.

## 3. Observability Review Workflow
1. When developing or running integration tests, inspect Wrangler logs:
   ```bash
   npx wrangler tail --format=pretty
   ```
2. Verify that every event envelope passes schema validation before processing.
3. Ensure no unhandled exceptions slip through the edge router without returning a sanitized JSON error envelope (`{ error: { code, message } }`).
