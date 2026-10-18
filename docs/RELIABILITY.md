# Agora Reliability, Fault Tolerance & Scalability

> Progressive Disclosure document detailing offline resilience, WebSocket reconnection, idempotency, and concurrent scaling architecture.

## 1. Zero-Downtime Presentation Guarantee (Offline Resilience)

A core premise of Agora is that live conference speaking cannot fail due to network, Wi-Fi, or edge outages.

### Design Principles:
1. **Reveal.js Runs Standalone**:
   The speaker's Reveal.js deck runs in a standard browser window with all assets bundled locally or cached via Service Worker.
2. **Decoupled Keyboard Event Handling**:
   The `RevealAudience` plugin binds listeners to standard Reveal.js navigation events (`slidechanged`), but never intercepts or blocks keyboard navigation (`ArrowLeft`, `ArrowRight`, `Space`, `PageDown`).
3. **Graceful Degradation**:
   If the WebSocket connection to the Cloudflare Worker drops:
   - The presenter can continue advancing slides uninterrupted.
   - The plugin queues pending transition events in memory.
   - An unobtrusive visual badge in the presenter controller indicates "Offline — Reconnecting".
   - The audience client displays a reconnection banner ("Connecting to live session...").

---

## 2. WebSocket Reconnection & State Synchronization

Audience mobile devices on conference Wi-Fi frequently drop packets or cycle connections when devices sleep.

### Reconnection Mechanics
1. **Exponential Backoff with Jitter**:
   - Initial retry: 500ms
   - Maximum backoff: 10,000ms
   - Randomized jitter factor: ±25% to prevent "thundering herd" reconnection spikes on access point restoration.
2. **State Hydration on Reconnect**:
   - Upon successful socket handshake (`GET /api/v1/sessions/:id/ws`), the server sends an authoritative `session.state` snapshot containing:
     - `currentSlideId`
     - `revealedSlideIds`
     - `pdfDownloadUnlocked`
     - Active poll or word cloud state (if open)
3. **Audience Position Catch-up**:
   - If attendee is in **Follow mode**, the client immediately updates its view to the current speaker slide.
   - If attendee is in **Solo mode**, the client maintains its inspected slide position, updates the set of accessible slides, and offers a "Jump to Live" badge.

---

## 3. Idempotency & Deduplication

In distributed edge topologies, duplicate messages can arise from network retries.

### Message Envelope UUIDs
Every `RealtimeEvent` sent across WebSockets or HTTP contains a unique `id` (UUIDv4):
```typescript
interface RealtimeEvent<T> {
  id: string;        // Client-generated UUID
  type: string;
  sessionId: string;
  timestamp: string;
  payload: T;
}
```

### Storage Deduplication
1. **Question Upvotes**:
   Enforced via SQLite composite primary key `(question_id, participant_id)`. Re-submitting an upvote is an idempotent `INSERT OR IGNORE`.
2. **Poll Votes**:
   Enforced via SQLite composite primary key `(poll_id, participant_id)`. Duplicate vote submissions are ignored.
3. **Slide State Transitions**:
   Transitions contain `(slideId, timestamp)`. Out-of-order or duplicate transition commands are dropped by comparing timestamps against the latest authoritative transition in the Durable Object.

---

## 4. Scalability Target: 500–1,000 Concurrent Participants

Agora is architected to easily sustain 500 concurrent participants, with a stretch target of 1,000 active attendees per session.

### Durable Object Concurrency Architecture
1. **WebSocket Hibernation API**:
   The Durable Object utilizes Cloudflare's WebSocket Hibernation API. Idle connections consume zero DO CPU time while maintaining active TCP/TLS sessions.
2. **Batched Aggregations**:
   High-frequency audience events (such as emoji reactions) are NOT broadcast individually to all 1,000 clients. Instead:
   - Attendees submit reactions to the Durable Object.
   - The Durable Object increments counters in-memory.
   - Every 500ms, an aggregated `reaction.summary` delta is emitted exclusively to the presenter and projection views.
3. **Read-Heavy Caching via Cloudflare Cache / CDN**:
   Static assets (slide PNGs, presentation PDFs, logos) are served from Cloudflare R2 through the Worker edge cache with `Cache-Control: public, max-age=31536000, immutable`, offloading high-volume download traffic from the Durable Object.
