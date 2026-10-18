# Agora System Architecture — System of Record

> System of Record document adhering to Harness Engineering Practice 3.
> This file is the authoritative single source of architectural truth for Agora.

## 1. System Overview

Agora is a real-time interactive presentation platform engineered to scale to 500–1,000 concurrent participants per presentation session. Presenters navigate using a Reveal.js slide deck, while audience members interact via mobile/web clients (asking slide-anchored questions, upvoting, reacting, answering polls/word-clouds, and downloading slide artifacts) without seeing raw presentation slide content on their mobile screens.

The platform is designed around Clean / Hexagonal Architecture with an event-driven edge runtime powered by Cloudflare Workers, Durable Objects with embedded SQLite, Cloudflare D1, and Cloudflare R2 object storage.

```
┌────────────────────────────────────────────────────────────────────────┐
│                          PRESENTATION LAYER                            │
│  ┌───────────────────┐  ┌───────────────────┐  ┌─────────────────────┐ │
│  │    apps/admin     │  │   apps/audience   │  │   apps/presenter    │ │
│  │ (React/Vite Admin)│  │ (React/Vite Mobile)│  │ (Reveal.js+Plugin)  │ │
│  └─────────┬─────────┘  └─────────┬─────────┘  └──────────┬──────────┘ │
└────────────┼──────────────────────┼───────────────────────┼────────────┘
             │ HTTP                 │ HTTP/WebSocket        │ WebSocket
             ▼                      ▼                       ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          apps/worker                                   │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                 Cloudflare Worker Edge Router                    │  │
│  └──────────────────┬───────────────────────────────┬───────────────┘  │
│                     │ Routing / Auth                │ Session Dispatch │
│                     ▼                               ▼                  │
│  ┌─────────────────────────────────────┐  ┌─────────────────────────┐  │
│  │ Cloudflare D1 (Global Relational)   │  │ Durable Object Session  │  │
│  │ - Presentations, Revisions, Slides  │  │ (Embedded SQLite)       │  │
│  │ - Asset Manifests, User Credentials │  │ - Active Slide State    │  │
│  └─────────────────────────────────────┘  │ - Questions & Upvotes   │  │
│                                           │ - Live Polls & Clouds   │  │
│  ┌─────────────────────────────────────┐  │ - WebSocket Hibernation │  │
│  │ Cloudflare R2 (Object Storage)      │  └─────────────────────────┘  │
│  │ - High-res Slide PNGs (current rev) │                               │
│  │ - Compiled Presentation PDFs        │                               │
│  │ - Media & Branding Assets           │                               │
│  └─────────────────────────────────────┘                               │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Monorepo Structure

Agora is organized as a pnpm workspace with strict dependency boundaries:

```text
/Users/alrs/Documents/agora/
├── apps/
│   ├── admin/               # React + Vite admin dashboard (presentation CRUD, assets, sessions)
│   ├── audience/            # React + Vite mobile audience PWA (Follow/Solo modes, Q&A, polls)
│   ├── presenter/           # Reveal.js presenter container & projection view
│   └── worker/              # Cloudflare Worker API & Durable Object session coordinator
├── packages/
│   ├── contracts/           # Shared TypeScript schemas, DTOs, API & WebSocket contracts
│   ├── domain/              # Pure business rules, domain entities, value objects (Zero external deps)
│   ├── application/         # Use cases, ports, orchestrators (Pure TypeScript, depends only on domain)
│   ├── reveal-plugin/       # Reusable RevealAudience plugin for Reveal.js
│   └── slide-export/        # Browser DOM capture (SlideRenderer) & PDF export abstractions
├── docs/                    # Progressive disclosure architectural documentation
├── docs/adr/                # Architecture Decision Records
├── sops/                    # Standard Operating Procedures
├── harness/                 # 14-Practice harness validation scripts & templates
└── tests/
    ├── unit/                # Pure domain & application unit tests
    ├── integration/         # Cloudflare Worker, Durable Object, SQLite, D1 integration tests
    ├── e2e/                 # Playwright end-to-end multi-client flows
    └── performance/         # 500-1,000 participant load and reconnection tests
```

---

## 3. Strict Architectural Dependency Rules

To prevent framework lock-in and ensure testability without Cloudflare/browser mocks, Agora enforces **mechanical dependency rules** verified by `harness/verify-architecture.mjs`:

```
┌─────────────────────────────────────────────────────────────┐
│                       packages/domain                       │
│  - Pure business invariants, entities, value objects        │
│  - ZERO dependencies on Cloudflare, React, Reveal, DOM      │
└──────────────────────────────▲──────────────────────────────┘
                               │ depends on
┌──────────────────────────────┴──────────────────────────────┐
│                     packages/application                    │
│  - Use cases, ports (interfaces), command/query handlers    │
│  - Depends ONLY on packages/domain & packages/contracts     │
│  - ZERO dependencies on Cloudflare, React, Reveal, DOM      │
└──────────────────────────────▲──────────────────────────────┘
                               │ implemented by
┌──────────────────────────────┴──────────────────────────────┐
│                    Infrastructure / Apps                    │
│  - apps/worker (Cloudflare Workers, Durable Objects, D1, R2)│
│  - apps/admin, apps/audience (React, Vite, DOM)             │
│  - packages/reveal-plugin (Reveal.js)                       │
│  - packages/slide-export (DOM capture implementations)      │
└─────────────────────────────────────────────────────────────┘
```

### Invariants:
1. `packages/domain` **MUST NOT** import from:
   - `cloudflare:workers`, `@cloudflare/workers-types`
   - `react`, `react-dom`
   - `reveal.js`
   - `apps/*`
   - Any browser DOM API (e.g. `document`, `window`, `HTMLElement`)
2. `packages/application` **MUST NOT** import from:
   - `cloudflare:workers`, `@cloudflare/workers-types`
   - `react`, `react-dom`
   - `reveal.js`
   - `apps/*`
3. All infrastructure dependencies (D1, SQLite, R2, WebSockets, HTTP) must be injected via interfaces declared in `packages/application/ports`.

---

## 4. Persistence & Storage Topology

Agora implements a split-persistence model matching read/write access patterns:

| Storage Layer | Engine | Data Managed | Isolation & Concurrency |
|---|---|---|---|
| **Administrative Persistence** | Cloudflare D1 (Global SQLite) | Presentation metadata, slides, revisions, asset manifests, admin accounts | Global consistency; read-heavy; mutated on presentation edits/duplication. |
| **Live Session Persistence** | Durable Object SQLite (In-Memory/Local NVMe) | Active session state, revealed slide list, questions, upvotes, poll responses, word clouds, rate limits | Strict single-writer consistency per session. 1 Durable Object per active session. |
| **Artifact & Asset Storage** | Cloudflare R2 | Current-revision slide PNGs, compiled PDFs, logos, media | Private bucket; access gated through authenticated worker endpoints. |

### Durable Object Embedded SQLite Schema
Inside each `SessionDurableObject`, embedded SQLite handles atomic session data:
- `session_meta`: `session_id`, `presentation_id`, `status` (`scheduled` | `live` | `completed`), `current_slide_id`, `pdf_download_unlocked`, `started_at`, `completed_at`
- `revealed_slides`: `slide_id`, `revealed_at`, `slide_order`
- `questions`: `id`, `slide_id`, `participant_id`, `participant_name`, `content`, `status`, `upvotes_count`, `created_at`
- `question_upvotes`: `question_id`, `participant_id`, `created_at` (PRIMARY KEY: `[question_id, participant_id]`)
- `reactions`: `slide_id`, `reaction_type`, `count`
- `polls`: `id`, `slide_id`, `question_text`, `poll_type`, `status` (`open` | `closed`), `created_at`
- `poll_votes`: `poll_id`, `participant_id`, `option_id`, `voted_at` (PRIMARY KEY: `[poll_id, participant_id]`)
- `word_cloud_entries`: `id`, `slide_id`, `normalized_word`, `count`

---

## 5. HTTP API Endpoints

All HTTP endpoints are versioned under `/api/v1` and handle JSON payloads:

### Presentation & Admin Management
- `POST /api/v1/presentations`: Create presentation draft
- `GET /api/v1/presentations/:id`: Retrieve presentation details & slide manifest
- `PUT /api/v1/presentations/:id`: Update presentation metadata (bumps revision)
- `POST /api/v1/presentations/:id/duplicate`: Deep-clone presentation metadata & slide manifest without copying sessions
- `POST /api/v1/presentations/:id/assets`: Register uploaded PNG or PDF asset manifest in D1 and R2

### Session Lifecycle
- `POST /api/v1/presentations/:id/sessions`: Initialize a new live presentation session
- `GET /api/v1/sessions/:id`: Retrieve audience-safe session state (active slide, revealed slides)
- `POST /api/v1/sessions/:id/join`: Anonymous participant join; issues session-scoped cryptographic token
- `POST /api/v1/sessions/:id/complete`: Presenter-authorized completion of session

### Audience Interactions (HTTP Fallback)
- `GET /api/v1/sessions/:id/questions`: List questions for session (filterable by `slideId`)
- `POST /api/v1/sessions/:id/questions`: Submit question anchored to current or revealed slide
- `POST /api/v1/sessions/:id/questions/:questionId/upvote`: Toggle upvote (idempotent)
- `POST /api/v1/sessions/:id/reactions`: Submit slide emoji reaction

### Gated Asset Downloads
- `GET /api/v1/sessions/:id/slides/:slideId/download`: Download high-res PNG for slide.
  *Authorization Invariant*: Returns 403 Forbidden unless `revealed_slides` contains `slideId` AND PNG asset exists.
- `GET /api/v1/sessions/:id/download`: Download full presentation PDF.
  *Authorization Invariant*: Returns 403 Forbidden unless `pdf_download_unlocked === true` AND PDF asset exists.

---

## 6. WebSocket Protocol & RealtimeEvent Envelope

Real-time synchronization between the Presenter deck, Audience mobile clients, and Worker uses standard WebSockets managed by Cloudflare Durable Object hibernation.

### Connection Endpoint
`GET /api/v1/sessions/:id/ws?token=<participant_or_presenter_token>&role=<audience|presenter>`

### RealtimeEvent Wire Envelope
Every client-to-server and server-to-client message adheres to the envelope:

```typescript
export interface RealtimeEvent<T = unknown> {
  id: string;               // Unique message UUID (for idempotency and deduplication)
  type: RealtimeEventType;  // Discriminated event type string
  sessionId: string;        // ID of target session
  timestamp: string;        // ISO 8601 UTC timestamp
  payload: T;               // Strongly-typed payload
}
```

### Event Taxonomy
| Event Type | Direction | Payload Description |
|---|---|---|
| `session.state` | Server -> Client | Full snapshot of active slide, revealed slide IDs, PDF unlock flag |
| `slide.changed` | Presenter -> Server -> All | Authoritative slide transition with `slideId`, `horizontalIndex`, `verticalIndex` |
| `question.submitted` | Audience -> Server -> Presenter | New question added to slide queue |
| `question.upvoted` | Audience -> Server -> All | Incremented/decremented question upvote count |
| `question.updated` | Presenter -> Server -> All | Question status change (`answered`, `dismissed`) |
| `reaction.added` | Audience -> Server | Incremental emoji reaction (`👍`, `🤔`, `❤️`, `😴`) |
| `reaction.summary` | Server -> Presenter | Aggregated reaction counts for current slide (batched at 500ms intervals) |
| `poll.opened` | Presenter -> Server -> Audience | Poll opened for active slide with options |
| `poll.voted` | Audience -> Server | Participant vote on poll |
| `poll.results` | Server -> All | Aggregated poll vote percentages |
| `wordcloud.submitted`| Audience -> Server | Word submission for word-cloud slide |
| `wordcloud.updated`  | Server -> All | Aggregated normalized word frequencies |
| `navigation.suggested`| Server -> Presenter | Adaptive branching recommendation based on poll outcome |
| `presentation.download.unlocked` | Server -> All | Broadcast when speaker reaches configured `endingSlideId` |

---

## 7. Key Domain Invariants & Business Rules

1. **Audience Never Sees Slide Content**:
   Audience clients display only slide title, order, questions, reactions, and polls. Raw slide DOM and visuals are never rendered in the audience app.
2. **Q&A Slide Projection Invariant**:
   When the presenter activates the embedded Q&A slide (`data-component="audience-qa"`), clicking a question opens a detail view with question text and the pre-rendered slide PNG *without navigating Reveal.js back to the referenced slide*. The projector remains stably locked on the Q&A slide.
3. **Presenter Controls Never Leak**:
   Arrows, reaction tallies, moderation controls, and admin buttons are isolated in `apps/presenter` and never visible on public projection views.
4. **Slide Revelation Monotonicity**:
   Once a slide is visited by the speaker, its ID is permanently added to `revealedSlideIds` for that session. Returning to earlier slides NEVER removes a slide from `revealedSlideIds`.
5. **PDF Unlock Monotonicity**:
   When an authorized speaker navigates to `endingSlideId`, `pdfDownloadUnlocked` becomes `true` permanently for the session. Navigating away does not lock it. Reaching the ending slide does NOT automatically complete the session.
6. **Offline Presentation Resilience**:
   Reveal.js presentations run completely standalone. If the Cloudflare Worker or WebSocket connection fails, speaker keyboard navigation operates without interruption.
