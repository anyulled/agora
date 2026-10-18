# Ágora Architecture & System of Record (`ARCHITECTURE.md`)

This document serves as the authoritative System of Record for **Ágora**, defining its architecture, C4 model hierarchy, domain boundaries, persistence topology, lifecycle state machines, and end-to-end sequence flows.

---

## Section 1: System Overview & C4 Model Architecture (Levels 1–4)

### 1.1 C4 Level 1 — System Context Diagram

```mermaid
flowchart TD
    subgraph Actors ["Actors & External Personas"]
        Admin["Presentation Admin / Author"]
        Presenter["Conference Speaker / Presenter"]
        Projector["Venue Public Projector"]
        Attendee["Conference Attendee (300-1,000 Peers)"]
    end

    subgraph AgoraSystem ["Ágora Interactive Conference Platform (System Boundary)"]
        AgoraCore["Ágora Edge & Real-Time Platform"]
    end

    subgraph BrowserEngines ["Browser Native Capabilities"]
        RevealEngine["Reveal.js Presentation Engine"]
        DomPrintEngine["Browser DOM Canvas & Print-PDF Engine"]
    end

    Admin -->|"Creates & Edits Decks"| AgoraCore
    Presenter -->|"Delivers Presentations & Navigates"| AgoraCore
    Projector -->|"Displays Live Projector View"| AgoraCore
    Attendee -->|"Joins via PWA & Interacts (Q&A/Polls)"| AgoraCore

    AgoraCore -->|"Embeds & Drives"| RevealEngine
    AgoraCore -->|"Captures PNGs & Renders PDF"| DomPrintEngine
```

---

### 1.2 C4 Level 2 — Container Diagram

```mermaid
flowchart TD
    subgraph ClientTier ["Client Tier (Browser Containers)"]
        AdminSPA["apps/admin (Admin Dashboard SPA)"]
        PresenterApp["apps/presenter (Speaker Deck + RevealAudience Plugin)"]
        AudiencePWA["apps/audience (Mobile Audience Companion)"]
        SlideExportPkg["packages/slide-export (SlideRenderer + Print-PDF)"]
    end

    subgraph EdgeTier ["Cloudflare Edge Tier (Worker & Stateful Compute)"]
        WorkerGateway["apps/worker (Cloudflare Worker API Gateway)"]
        SessionDO["SessionCoordinatorDO (Durable Object + WebSocket Hibernation)"]
    end

    subgraph StorageTier ["Storage Tier (Local Emulated via node:sqlite or Cloudflare Edge)"]
        D1DB[("Cloudflare D1 SQLite (Presentations, Slides, Manifests, Rules)")]
        DOSQLite[("Durable Object Embedded SQLite (Session State, Q&A, Votes, Dedup)")]
        R2Store[("Cloudflare R2 Private Bucket (Slide PNGs & Full Deck PDF)")]
    end

    AdminSPA -->|"HTTP REST API"| WorkerGateway
    PresenterApp -->|"WebSocket & HTTP"| WorkerGateway
    AudiencePWA -->|"WebSocket & HTTP"| WorkerGateway
    SlideExportPkg -->|"Browser DOM Capture"| WorkerGateway

    WorkerGateway -->|"Queries / Mutates"| D1DB
    WorkerGateway -->|"Routs Realtime Sessions"| SessionDO
    WorkerGateway -->|"Gets / Puts Assets"| R2Store

    SessionDO -->|"Persists State"| DOSQLite
```

---

### 1.3 C4 Level 3 — Component Diagram

```mermaid
flowchart TD
    subgraph WorkerComponents ["apps/worker & SessionCoordinatorDO Components"]
        HttpRouter["HTTP API Router (/api/v1/*)"]
        AuthGate["Admin & Token Auth Guard"]
        AssetGate["R2 Asset Gatekeeper (PNG & PDF Authorization)"]
        WsHub["WebSocket Hibernation & Broadcast Hub"]
        EmulatorAdapter["Cloudflare Emulator Adapter (LocalD1, LocalR2, LocalDO)"]
    end

    subgraph AppComponents ["packages/application Components (Pure Use-Case Orchestration)"]
        PlatformService["AgoraPlatformService (Application Facade)"]
    end

    subgraph DomainComponents ["packages/domain Components (100% Pure Domain Rules)"]
        PresentationDomain["Presentation & Revision Asset Invalidation"]
        NavigationDomain["Follow/Solo Navigation & Ending-Slide Unlock"]
        InteractionDomain["Q&A Sanitizer, Upvote Toggle, Polls & Word Cloud"]
        AdaptiveNavDomain["Adaptive Navigation Rule Evaluator"]
        RateLimitDomain["Sliding-Window RateLimiter"]
    end

    subgraph ContractsPkg ["packages/contracts"]
        SharedContracts["Shared DTOs & RealtimeEvent Envelopes"]
    end

    HttpRouter --> AuthGate
    AuthGate --> AssetGate
    AuthGate --> PlatformService
    WsHub --> PlatformService
    PlatformService --> PresentationDomain
    PlatformService --> NavigationDomain
    PlatformService --> InteractionDomain
    PlatformService --> AdaptiveNavDomain
    PlatformService --> RateLimitDomain
    PlatformService --> SharedContracts
    EmulatorAdapter --> WorkerComponents
```

---

### 1.4 C4 Level 4 — Code & Domain Class Diagram

```mermaid
classDiagram
    class Presentation {
        +string id
        +string title
        +int revision
        +string status
        +validateRevision()
        +bumpRevision()
    }

    class Slide {
        +string id
        +string presentationId
        +int slideIndex
        +string contentHtml
        +string imageAssetKey
        +boolean isEndingSlide
    }

    class PresentationSession {
        +string sessionId
        +string presentationId
        +string status
        +list revealedSlideIds
        +boolean pdfDownloadUnlocked
        +updateNavigation()
        +unlockPdf()
    }

    class SlideQuestion {
        +string questionId
        +string sessionId
        +string slideId
        +string participantId
        +string body
        +int upvotes
        +string status
        +sanitize()
        +toggleUpvote()
    }

    class Poll {
        +string pollId
        +string sessionId
        +string question
        +list options
        +boolean isActive
        +castVote()
    }

    class AdaptiveNavigationRule {
        +string ruleId
        +string triggerType
        +float threshold
        +string targetSlideId
        +evaluate()
    }

    class WordCloudPrompt {
        +string promptId
        +string sessionId
        +string term
        +int count
        +normalizeTerm()
    }

    class AssetManifest {
        +string presentationId
        +int revision
        +list slideAssetKeys
        +string fullPdfKey
        +isValid()
    }

    class AgoraPlatformService {
        +createPresentation()
        +handleSessionNavigation()
        +submitQuestion()
        +castPollVote()
    }

    class RateLimiter {
        +int windowMs
        +int maxRequests
        +checkLimit(clientId)
    }

    class SessionCoordinatorDO {
        +string sessionId
        +SqliteStorage storage
        +handleWebSocketMessage()
        +broadcastState()
    }

    Presentation "1" --> "*" Slide : contains
    Presentation "1" --> "1" AssetManifest : has
    PresentationSession "1" --> "1" Presentation : runs
    PresentationSession "1" --> "*" SlideQuestion : collects
    PresentationSession "1" --> "*" Poll : features
    PresentationSession "1" --> "*" WordCloudPrompt : aggregates
    AgoraPlatformService --> Presentation
    AgoraPlatformService --> PresentationSession
    AgoraPlatformService --> RateLimiter
    SessionCoordinatorDO --> PresentationSession
```

---

## Section 2: Monorepo Structure & Clean Architecture Dependency Rules

### 2.1 Monorepo Directory Layout
```
/Users/alrs/Documents/agora/
├── apps/
│   ├── admin/             # Admin Dashboard SPA
│   ├── audience/          # Mobile Audience Companion PWA
│   ├── presenter/         # Speaker Deck + RevealAudience Plugin
│   └── worker/            # Cloudflare Worker API Gateway & Durable Objects
├── packages/
│   ├── application/       # Pure use-case orchestration
│   ├── contracts/         # Shared DTOs and RealtimeEvent envelopes
│   ├── domain/            # 100% Pure domain business rules & invariants
│   ├── emulator/          # Local Cloudflare emulation (node:sqlite + local R2)
│   ├── slide-export/      # SlideRenderer & Print-PDF capture engine
│   └── ui/                # Shared design system components
├── harness/               # Architecture verifiers and victory detectors
└── docs/                  # System documentation & specifications
```

### 2.2 Mechanical Dependency Rules & Invariants
- **Strict Domain Boundary**: `packages/domain` and `packages/application` **MUST NEVER** import Cloudflare Workers, React, DOM, or Reveal.js.
- **Enforcement**: Enforced by `harness/verify-architecture.mjs`, ESLint rules (`eslint.config.mjs`), and TypeScript project references.
- **WIP = 1 Invariant**: At most one feature active in `feature_list.json` at any given time.

---

## Section 3: Persistence Topology & Entity-Relationship Diagram (`erDiagram`)

### 3.1 Storage Comparison
| Storage Layer | Technology | Purpose & Access Pattern |
| :--- | :--- | :--- |
| **Global Storage** | Cloudflare D1 SQLite | Presentations, slides, markdown sources, asset manifests, navigation rules. Read-heavy. |
| **Stateful Edge Compute** | Durable Object SQLite | Real-time session state, participant tracking, Q&A, votes, event deduplication (`ctx.storage.sql`). |
| **Asset Storage** | Cloudflare R2 Private Bucket | Static slide PNGs, full deck PDFs, authorized via signed URL gateways. |
| **Local Emulation** | `packages/emulator` (`node:sqlite`) | Local development without requiring remote Cloudflare deployment. |

### 3.2 Entity-Relationship Diagram (`erDiagram`)

```mermaid
erDiagram
    PRESENTATIONS {
        string id PK
        string title
        int revision
        string status
        datetime created_at
    }
    SLIDES {
        string id PK
        string presentation_id FK
        int slide_index
        string content_html
        string image_asset_key
        boolean is_ending_slide
    }
    ASSET_MANIFESTS {
        string manifest_id PK
        string presentation_id FK
        int revision
        string slide_asset_keys_json
        string full_pdf_key
    }
    NAVIGATION_RULES {
        string rule_id PK
        string presentation_id FK
        string trigger_type
        float threshold
        string target_slide_id
    }
    SESSION_STATE {
        string session_id PK
        string presentation_id FK
        string status
        string current_slide_id
        string revealed_slide_ids_json
        boolean pdf_download_unlocked
    }
    PARTICIPANTS {
        string participant_id PK
        string session_id FK
        string token_hash
        datetime joined_at
    }
    QUESTIONS {
        string question_id PK
        string session_id FK
        string slide_id FK
        string participant_id FK
        string body
        int upvotes
        string status
        datetime created_at
    }
    QUESTION_UPVOTES {
        string question_id PK, FK
        string participant_id PK, FK
    }
    REACTIONS {
        string reaction_id PK
        string session_id FK
        string participant_id FK
        string emoji
        datetime created_at
    }
    POLLS {
        string poll_id PK
        string session_id FK
        string question
        string options_json
        boolean is_active
    }
    POLL_VOTES {
        string poll_id PK, FK
        string participant_id PK, FK
        string selected_option
    }
    WORDCLOUD_SUBMISSIONS {
        string prompt_id PK, FK
        string participant_id PK, FK
        string term
        int count
    }
    PROCESSED_EVENTS {
        string event_id PK
        string session_id FK
        datetime processed_at
    }

    PRESENTATIONS ||--|{ SLIDES : contains
    PRESENTATIONS ||--|| ASSET_MANIFESTS : has
    PRESENTATIONS ||--o{ NAVIGATION_RULES : defines
    PRESENTATIONS ||--o{ SESSION_STATE : runs_in
    SESSION_STATE ||--o{ PARTICIPANTS : tracks
    SESSION_STATE ||--o{ QUESTIONS : receives
    QUESTIONS ||--o{ QUESTION_UPVOTES : gets_upvoted_by
    PARTICIPANTS ||--o{ QUESTION_UPVOTES : casts
    SESSION_STATE ||--o{ REACTIONS : records
    SESSION_STATE ||--o{ POLLS : hosts
    POLLS ||--o{ POLL_VOTES : collects
    SESSION_STATE ||--o{ WORDCLOUD_SUBMISSIONS : aggregates
    SESSION_STATE ||--o{ PROCESSED_EVENTS : deduplicates
```

---

## Section 4: Session & Asset Lifecycle State Machine (`stateDiagram-v2`)

```mermaid
stateDiagram-v2
    [*] --> Draft : Author creates deck
    Draft --> AssetsGenerated : Browser DOM capture renders PNGs & PDF
    AssetsGenerated --> StaleAssetsInvalidated : Slide edited (rev incremented)
    StaleAssetsInvalidated --> AssetsGenerated : Re-render capture

    state LiveSession {
        [*] --> Scheduled
        Scheduled --> Live_FollowAndSolo : Presenter starts session
        Live_FollowAndSolo --> RevealedSlidesGrowing : Presenter navigates slides
        RevealedSlidesGrowing --> EndingSlideVisited_PdfUnlocked : Presenter visits ending slide
        EndingSlideVisited_PdfUnlocked --> SessionCompleted : Presenter clicks Complete
    }

    AssetsGenerated --> Scheduled : Session initialized
```

---

## Section 5: End-to-End Sequence Diagrams (`sequenceDiagram`)

### 5.1 Presentation Authoring, Browser-Side PNG Capture, Native PDF Export & Asset Invalidation (`SPEC-001`, `SPEC-013`, `SPEC-015`, `SPEC-024`)

```mermaid
sequenceDiagram
    autonumber
    actor Admin as Presentation Admin / Author
    participant AdminApp as apps/admin SPA
    participant SlideExport as packages/slide-export
    participant Worker as apps/worker API Gateway
    participant D1 as Cloudflare D1 SQLite
    participant R2 as Cloudflare R2 Bucket

    Admin->>AdminApp: Create / Edit Presentation Markdown
    AdminApp->>Worker: POST /api/v1/presentations (rev-1)
    Worker->>D1: Insert presentation & slides record
    D1-->>Worker: Presentation Saved
    Worker-->>AdminApp: 201 Created (revision: 1)

    AdminApp->>SlideExport: Render Deck & Force `.fragment.visible` Final State
    SlideExport->>SlideExport: Capture Slide PNG Canvas & Full Deck PDF
    SlideExport->>Worker: PUT /api/v1/presentations/{id}/assets (Multipart PNGs + PDF)
    Worker->>R2: Store static PNGs & Full PDF in R2
    R2-->>Worker: Stored Successfully
    Worker->>D1: Update AssetManifest (revision: 1)
    Worker-->>AdminApp: 200 OK (Assets Registered)

    Note over Admin,R2: Subsequent Edit Invalidation Scenario
    Admin->>AdminApp: Edit Slide Markdown Content
    AdminApp->>Worker: PUT /api/v1/presentations/{id} (Bump rev to rev-2)
    Worker->>D1: Update revision=2 & Mark manifest stale
    Worker-->>AdminApp: 200 OK (Revision Incremented, Assets Invalidated)
```

---

### 5.2 Anonymous Attendee Join, Presenter Slide Navigation & Follow vs. Solo Mode (`SPEC-002`, `SPEC-003`, `SPEC-004`, `SPEC-005`, `SPEC-023`)

```mermaid
sequenceDiagram
    autonumber
    actor Attendee as Conference Attendee
    actor Presenter as Conference Speaker
    participant PApp as apps/presenter
    participant APWA as apps/audience PWA
    participant Worker as apps/worker Gateway
    participant DO as SessionCoordinatorDO

    Attendee->>APWA: Open Session URL (e.g. /session/abc)
    APWA->>Worker: POST /api/v1/sessions/abc/join
    Worker->>DO: Register Anonymous Participant
    DO-->>Worker: Issued Opaque participantToken
    Worker-->>APWA: 200 OK (participantToken + Initial State)

    Note over Presenter,DO: Presenter Navigation
    Presenter->>PApp: Navigate to slide-3 (Skipped slide-2)
    PApp->>Worker: WS / HTTP POST /api/v1/sessions/abc/navigation
    Worker->>DO: Update currentSlideId = slide-3, add slide-3 to revealedSlideIds
    DO-->>Worker: Broadcast RealtimeEvent (slide.changed)
    Worker-->>APWA: WS Broadcast: { currentSlideId: "slide-3", revealedSlideIds: ["slide-1", "slide-3"] }

    Note over Attendee,DO: Follow vs Solo Mode Verification
    alt Follow Mode Enabled
        APWA->>APWA: Auto-snap view to slide-3
    else Solo Mode Enabled
        APWA->>APWA: Allow browsing revealed slides (slide-1, slide-3)
        Attendee->>APWA: Attempt to browse skipped slide-2
        APWA->>Worker: GET /api/v1/sessions/abc/slides/slide-2/png
        Worker->>DO: Verify slide-2 in revealedSlideIds? (False)
        Worker-->>APWA: 403 Forbidden (Slide Not Yet Revealed)
    end
```

---

### 5.3 Slide-Scoped Q&A Submission, Idempotent Upvoting & Embedded Q&A Detail View Without Deck Navigation (`SPEC-006`, `SPEC-007`, `SPEC-008`, `SPEC-018`)

```mermaid
sequenceDiagram
    autonumber
    actor Attendee as Conference Attendee
    actor Presenter as Conference Speaker
    participant APWA as apps/audience PWA
    participant PApp as apps/presenter (RevealAudience Plugin)
    participant Worker as apps/worker Gateway
    participant DO as SessionCoordinatorDO

    Attendee->>APWA: Submit Q&A question on slide-3 ("How does scaling work?")
    APWA->>Worker: POST /api/v1/sessions/abc/questions (XSS Sanitized & Rate-Limited)
    Worker->>DO: Insert question into DO SQLite, broadcast question.created
    DO-->>PApp: WebSocket Broadcast (New Question Added)

    Note over Attendee,DO: Idempotent Upvoting
    Attendee->>APWA: Click Upvote on Question
    APWA->>Worker: POST /api/v1/sessions/abc/questions/{id}/upvote
    Worker->>DO: Insert into QUESTION_UPVOTES (UNIQUE constraint on question_id, participant_id)
    DO-->>APWA: 200 OK (Upvote Count Incremented)

    Note over Presenter,PApp: Embedded Q&A Detail View
    Presenter->>PApp: View `data-component="audience-qa"` overlay (Projector remains locked on slide-3)
    Presenter->>PApp: Click top question referencing slide-1
    PApp->>PApp: RevealAudience opens internal `detail` view
    PApp->>Worker: GET /api/v1/presentations/{id}/slides/slide-1/png
    Worker-->>PApp: 200 OK (Return Slide-1 Static PNG from R2)
    PApp->>Presenter: Display Slide-1 PNG inside Q&A detail panel without changing main presentation deck position
    Presenter->>PApp: Click Mark Answered & Press Escape
    PApp->>Worker: PATCH /api/v1/sessions/abc/questions/{id} (status: answered)
    PApp->>PApp: Return to Q&A list view
```

---

### 5.4 Contextual Polls, Adaptive Navigation Suggestion & Word Cloud Normalization (`SPEC-010`, `SPEC-011`, `SPEC-021`)

```mermaid
sequenceDiagram
    autonumber
    actor Presenter as Conference Speaker
    actor Attendee as Conference Attendee
    participant PApp as apps/presenter
    participant APWA as apps/audience PWA
    participant Worker as apps/worker Gateway
    participant DO as SessionCoordinatorDO

    Presenter->>PApp: Launch Poll on Slide-3
    PApp->>Worker: POST /api/v1/sessions/abc/polls (Active)
    Worker->>DO: Activate Poll & Broadcast poll.opened
    DO-->>APWA: WebSocket Broadcast (Poll Active)

    Attendee->>APWA: Cast Poll Vote
    APWA->>Worker: POST /api/v1/sessions/abc/polls/{id}/vote
    Worker->>DO: Record Vote & Evaluate Adaptive Navigation Rules

    Note over DO,Presenter: Adaptive Navigation Evaluation
    DO->>DO: evaluateAdaptiveNavigationRules() -> Threshold met (e.g. 80% vote Option A)
    DO-->>PApp: WebSocket Broadcast (navigation.suggested -> Target: Slide-5)
    Presenter->>PApp: Click Confirm Adaptive Navigation Jump
    PApp->>Worker: POST /api/v1/sessions/abc/navigation/jump (slide-5)
    Worker->>DO: Update currentSlideId = slide-5, add to revealedSlideIds
    DO-->>APWA: Broadcast slide.changed

    Note over Attendee,DO: Word Cloud Normalization
    Attendee->>APWA: Submit Word Cloud Term ("Kubernetes!")
    APWA->>Worker: POST /api/v1/sessions/abc/wordcloud
    Worker->>DO: normalizeWordCloudTerm("Kubernetes!") -> "kubernetes", increment count
    DO-->>PApp: Broadcast wordcloud.updated
```

---

### 5.5 Gated Slide PNG Download, Ending-Slide Full PDF Unlock & Explicit Session Completion (`SPEC-014`, `SPEC-016`, `SPEC-022`, `SPEC-024`)

```mermaid
sequenceDiagram
    autonumber
    actor Attendee as Conference Attendee
    actor Presenter as Conference Speaker
    participant APWA as apps/audience PWA
    participant PApp as apps/presenter
    participant Worker as apps/worker Gateway
    participant DO as SessionCoordinatorDO
    participant R2 as Cloudflare R2 Bucket

    Attendee->>APWA: Request unrevealed slide-4 PNG
    APWA->>Worker: GET /api/v1/sessions/abc/slides/slide-4/png
    Worker->>DO: Check revealedSlideIds -> False
    Worker-->>APWA: 403 Forbidden (Gated Asset)

    Attendee->>APWA: Request revealed slide-1 PNG
    APWA->>Worker: GET /api/v1/sessions/abc/slides/slide-1/png
    Worker->>DO: Check revealedSlideIds -> True
    Worker->>R2: Fetch signed URL for slide-1 PNG
    R2-->>Worker: Signed URL / Stream
    Worker-->>APWA: 200 OK (Slide-1 PNG Streamed)

    Note over Presenter,DO: Ending Slide Full PDF Unlock
    Presenter->>PApp: Navigate to designated `isEndingSlide: true`
    PApp->>Worker: POST /api/v1/sessions/abc/navigation (currentSlideId: ending-slide)
    Worker->>DO: Detect isEndingSlide visited -> Set pdfDownloadUnlocked = true (Permanent)
    DO-->>APWA: Broadcast session.unlocked (pdfDownloadUnlocked: true)

    Attendee->>APWA: Request Full Presentation PDF
    APWA->>Worker: GET /api/v1/sessions/abc/pdf-download
    Worker->>DO: Verify pdfDownloadUnlocked == true
    Worker->>R2: Fetch Full Deck PDF
    R2-->>Worker: PDF Stream
    Worker-->>APWA: 200 OK (Full PDF Downloaded)

    Presenter->>PApp: Click Explicit Session Completion
    PApp->>Worker: POST /api/v1/sessions/abc/complete
    Worker->>DO: Set session.status = 'completed'
    DO-->>APWA: Broadcast session.completed
```

---

### 5.6 Offline Reveal.js Resilience, Exponential Backoff Reconnection & Event Deduplication (`SPEC-003`, `SPEC-019`)

```mermaid
sequenceDiagram
    autonumber
    actor Presenter as Conference Speaker
    participant PApp as apps/presenter (Reveal.js + RevealAudience)
    participant Worker as apps/worker Gateway
    participant DO as SessionCoordinatorDO

    Note over Presenter,Worker: Network Connection Drops
    Presenter->>PApp: Press ArrowRight (Advance Local Slide)
    PApp->>PApp: Reveal.js advances locally without blocking!
    PApp->>Worker: WS / HTTP Sync Request (Fails: Network Disconnected)
    PApp->>PApp: Catch WebSocket/Fetch error -> Queue state change locally

    Note over PApp,DO: Reconnection & Deduplication Loop
    loop Exponential Backoff
        PApp->>PApp: computeBackoffDelayMs(attempt) -> Wait & Retry
        PApp->>Worker: WS Reconnect / Sync Queued State (eventId: "evt-123")
    end

    Worker->>DO: Process Sync Request (eventId: "evt-123")
    DO->>DO: Check PROCESSED_EVENTS table for "evt-123"
    alt Event Already Processed
        DO-->>Worker: Acknowledge idempotent duplicate
    else New Event
        DO->>DO: Insert into PROCESSED_EVENTS & Update Session State
        DO-->>PApp: State Resynchronized
    end
    PApp->>PApp: Clear local offline queue, connection fully restored
```

---

## Section 6: HTTP API & WebSocket RealtimeEvent Reference

### 6.1 HTTP REST API Endpoints (`/api/v1/*`)
| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/v1/presentations` | `POST` | Create a new presentation deck with markdown and slides. |
| `/api/v1/presentations/{id}` | `PUT` | Update presentation revision and invalidate stale assets. |
| `/api/v1/presentations/{id}/assets` | `PUT` | Upload rendered slide PNGs and full PDF to R2. |
| `/api/v1/sessions` | `POST` | Initialize a live presentation session. |
| `/api/v1/sessions/{id}/join` | `POST` | Join session anonymously, returning an opaque `participantToken`. |
| `/api/v1/sessions/{id}/navigation` | `POST` | Update current slide and revealed slide IDs. |
| `/api/v1/sessions/{id}/questions` | `POST` | Submit XSS-sanitized and rate-limited Q&A question. |
| `/api/v1/sessions/{id}/questions/{qid}/upvote` | `POST` | Idempotently toggle question upvote. |
| `/api/v1/sessions/{id}/polls` | `POST` | Create or activate a contextual poll. |
| `/api/v1/sessions/{id}/polls/{pid}/vote` | `POST` | Cast vote on an active poll. |
| `/api/v1/sessions/{id}/wordcloud` | `POST` | Submit and normalize word cloud term. |
| `/api/v1/sessions/{id}/slides/{sid}/png` | `GET` | Gated retrieval of slide PNG from R2 (`403` if unrevealed). |
| `/api/v1/sessions/{id}/pdf-download` | `GET` | Download full presentation PDF (`403` if ending slide not visited). |
| `/api/v1/sessions/{id}/complete` | `POST` | Explicitly complete and lock session. |

### 6.2 WebSocket RealtimeEvent Envelopes
| Event Type | Payload | Description |
| :--- | :--- | :--- |
| `slide.changed` | `{ currentSlideId, revealedSlideIds }` | Broadcasted when presenter changes slides. |
| `question.created` | `{ questionId, slideId, body, upvotes }` | Broadcasted when a new question is submitted. |
| `question.upvoted` | `{ questionId, upvotes }` | Broadcasted when a question upvote count changes. |
| `poll.opened` | `{ pollId, question, options }` | Broadcasted when a poll becomes active. |
| `navigation.suggested` | `{ ruleId, targetSlideId, triggerType }` | Broadcasted when adaptive navigation rules trigger. |
| `wordcloud.updated` | `{ promptId, terms }` | Broadcasted when word cloud terms are aggregated. |
| `session.unlocked` | `{ pdfDownloadUnlocked }` | Broadcasted when ending slide is reached. |
| `session.completed` | `{ status: "completed" }` | Broadcasted when session ends. |
