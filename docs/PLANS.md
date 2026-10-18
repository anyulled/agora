# Agora Implementation Lifecycle — 8 Vertical Slices

> Progressive Disclosure document outlining the 8 vertical slices of Agora development from Foundations to Hardening.

Agora follows an incremental, vertical-slice implementation strategy. Each slice is an end-to-end, testable capability cutting through domain, application, storage, and presentation layers.

```
Foundations ──► Navigation ──► Audience ──► Q&A ──► Reactions ──► Interactions ──► Exports ──► Hardening
  (Slice 1)      (Slice 2)     (Slice 3)   (Slice 4)  (Slice 5)     (Slice 6)     (Slice 7)    (Slice 8)
```

---

## Slice 1: Foundations
- **Scope**: Core monorepo scaffolding, Cloudflare Worker API router, D1 relational schema migrations, Durable Object skeleton with SQLite initialization, and R2 asset bucket configuration.
- **Deliverables**:
  - `packages/contracts`: Core schemas and DTOs.
  - `packages/domain`: Pure entities (`Presentation`, `SlideMetadata`, `Session`).
  - `apps/worker`: REST endpoints for presentation CRUD and D1 persistence.
- **Verification**: Integration tests validating D1 migration and basic Durable Object instantiation.

## Slice 2: Navigation & Presentation Sync
- **Scope**: Reveal.js integration, session creation, presenter vs. projector coordination.
- **Deliverables**:
  - `packages/reveal-plugin`: `RevealAudience` initial implementation.
  - `apps/presenter`: Presenter navigation interface with directional controls.
  - Real-time `slide.changed` event propagation over WebSockets.
- **Verification**: E2E test showing presenter navigation instantly updating the projected Reveal.js slide.

## Slice 3: Audience Core (Follow & Solo Modes)
- **Scope**: Anonymous attendee join flow, session token generation, Follow mode synchronization, and Solo mode browsing.
- **Deliverables**:
  - `apps/audience`: Mobile web interface with Follow/Solo toggle and slide titles.
  - Durable Object `revealedSlideIds` tracking.
  - Security validation: Skipped slides strictly blocked from audience access.
- **Verification**: Multi-client test verifying that navigating speaker reveals slides, and attendees in Solo mode can only browse visited slides.

## Slice 4: Slide-Scoped Q&A
- **Scope**: Audience question submission, upvoting, ranked ordering, and embedded Q&A Reveal.js slide.
- **Deliverables**:
  - SQLite tables for questions and upvotes with composite primary keys.
  - `packages/reveal-plugin`: Q&A component supporting list view and detail view with referenced slide image.
  - Projection invariant: Selecting a question does not navigate Reveal.js away from the Q&A slide.
- **Verification**: Unit and E2E tests verifying upvote idempotency and Q&A slide stability during detail inspection.

## Slice 5: Emoji Reactions
- **Scope**: Real-time slide reactions (`👍`, `🤔`, `❤️`, `😴`), rate limiting, batched aggregation, and presenter tally displays.
- **Deliverables**:
  - Reaction submission endpoint and WebSocket handler.
  - In-memory 500ms aggregation loop in Durable Object.
  - Presenter view real-time reaction counter HUD.
- **Verification**: High-volume unit test verifying rate limiting and aggregation without message flooding.

## Slice 6: Live Interactions (Polls & Word Clouds)
- **Scope**: Interactive slide polls (single/multiple choice) and live word clouds.
- **Deliverables**:
  - Poll state machine (open, closed, results revealed).
  - Word cloud text normalization, sanitization, and frequency aggregation.
  - Adaptive navigation: Branch suggestions presented to speaker based on poll outcomes.
- **Verification**: Integration test proving one-vote-per-participant enforcement and adaptive suggestion generation.

## Slice 7: Slide Artifacts & Downloads
- **Scope**: Browser-side DOM capture for slide PNGs, native Reveal.js PDF generation, and gated audience download authorization.
- **Deliverables**:
  - `packages/slide-export`: `SlideRenderer` DOM capture implementation.
  - Ending slide detection: Visiting configured `endingSlideId` permanently unlocks PDF download.
  - Gated download endpoints: Returning 403 Forbidden for unrevealed PNGs or locked PDFs.
- **Verification**: Security tests verifying unauthorized download requests fail with 403.

## Slice 8: Hardening, Performance & Reliability
- **Scope**: Security audit, WebSocket reconnection resilience, offline Reveal.js fallback, and 500–1,000 participant load testing.
- **Deliverables**:
  - Exponential backoff and state recovery for dropped connections.
  - Cloudflare Worker rate limiting and token validation.
  - Performance test suite simulating 500 concurrent participants actively voting and reacting.
  - Mechanical CI/CD pipelines in `.github/workflows/`.
- **Verification**: Complete test suite execution passing within CI budget (`pnpm run verify`).
