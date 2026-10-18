# Interactive Presentation Platform — MVP Specification

**Version:** 0.1.0  
**Status:** Implementation-ready draft  
**Stack:** TypeScript, Reveal.js, Cloudflare Workers, Durable Objects (SQLite), D1, R2

## 1. Goal

Build an interactive conference-presentation platform for approximately 300–500 simultaneous attendees, with a stretch target of 1,000. The speaker presents using Reveal.js; attendees use a separate mobile web application for slide-contextual questions, upvotes, reactions, polls, word clouds, and downloads. Support adaptive, presenter-controlled branching. Keep the presentation functional if real-time services fail.

## 2. Product principles and boundaries

- Reveal.js owns projected slide rendering and keyboard navigation.
- Audience members **do not see slide content** in their interface. They see slide title/number, ask-question control, emoji reactions, download control, and (in Solo mode) navigation arrows.
- Questions refer to a **whole slide**, never to individual fragments.
- Every slide has a stable ID, title, and ordering metadata. Use IDs rather than slide indices for references.
- A slide becomes audience-accessible once the speaker visits it and remains accessible for the rest of the session, even if the speaker navigates backward. Skipped slides remain locked.
- A single-slide PNG can be downloaded only if the slide has been revealed **and** its image has been generated.
- The full PDF unlocks only upon the speaker's first authorized visit to a configured ending slide; it remains unlocked thereafter. This does not automatically end the session.
- The exported PDF includes **all** slides, including skipped slides. Excluding skipped slides is a post-MVP enhancement.
- PNG exports represent only the final visual state of each slide; no separate fragment-state images. Questions reference the slide as a whole.
- Presentations are independently customized per event; admins may **duplicate** a presentation and then edit branding/content independently. Session interactions are not duplicated.
- No speaker-only content export restrictions in MVP. Speaker notes integration is post-MVP.
- Keep domain/application logic independent of Cloudflare, React, and Reveal.js.

## 3. Architecture

| Concern | Technology | Responsibility |
|---|---|---|
| Presentation | Reveal.js + TypeScript plugin | Navigation, slide metadata, embedded Q&A slide, polls, presenter interaction |
| Audience app | React + Vite + TypeScript | Follow/Solo modes, questions, voting, reactions, download controls |
| Administration app | React + Vite + TypeScript | Presentation CRUD/duplication, branding, sessions, asset generation/upload |
| Presenter view | Reveal.js-integrated UI | Current slide, arrow controls, reactions, question/participant counts |
| API | Cloudflare Workers | HTTP routing, authorization, asset access, admin operations |
| Live session | Durable Object per session | WebSocket coordination, authoritative slide state, session-scoped interactions |
| Live persistence | Durable Object embedded SQLite | Questions, votes, reactions, polls, participant/session state |
| Administrative persistence | Cloudflare D1 | Presentation metadata, slide manifests, revisions, asset manifests |
| Assets | Cloudflare R2 | Generated PNGs, uploaded PDFs, logos and presentation assets |
| Tooling | Wrangler, GitHub Actions | Local development and deployments |
| Testing | Vitest, Playwright | Unit, integration, E2E and browser/export checks |

Use WebSocket hibernation where practical. Do not assume free-tier concurrency or latency guarantees; verify current limits and load-test. Avoid making generated assets publicly enumerable. Reveal.js presentation source, if publicly hosted, is not confidential; restricting audience navigation alone does not prevent someone inspecting the underlying deck.

### Suggested monorepo

```text
interactive-presentations/
  apps/
    admin/
    audience/
    presenter/
    worker/
  packages/
    domain/
    application/
    contracts/
    reveal-plugin/
    slide-export/
  tests/
    integration/
    e2e/
    performance/
  infrastructure/cloudflare/
  docs/adr/
```

Applications can share deployments when this reduces complexity.

## 4. Domain entities

```typescript
interface Presentation {
  id: string;
  title: string;
  description?: string;
  eventName?: string;
  revision: string;
  status: 'draft' | 'published';
  endingSlideId: string;
  branding: { colors: Record<string, string>; logoAssetId?: string };
}

interface SlideMetadata {
  id: string;
  presentationId: string;
  title: string;
  horizontalIndex: number;
  verticalIndex: number;
  order: number;
}

interface PresentationSession {
  id: string;
  presentationId: string;
  status: 'scheduled' | 'live' | 'completed';
  currentSlideId: string | null;
  revealedSlideIds: string[];
  pdfDownloadUnlocked: boolean;
  startedAt?: string;
  completedAt?: string;
}

interface AudienceQuestion {
  id: string;
  sessionId: string;
  slideId: string;
  participantId: string;
  participantName?: string;
  content: string;
  status: 'pending' | 'answered' | 'dismissed';
  createdAt: string;
}

type AudienceMode = 'follow' | 'solo';
type Reaction = '👍' | '🤔' | '❤️' | '😴';
```

Model poll questions, response options, votes, word-cloud submissions, participant identities, and asset manifests explicitly. Enforce uniqueness and idempotency for upvotes/poll responses in persistent storage. Session IDs isolate interactions; presentation IDs isolate content and assets.

## 5. Functional requirements and acceptance criteria

### SPEC-001 — Presentation administration

- Admin can create, edit, publish, duplicate, and delete presentations.
- Each presentation has title, optional description/event, theme colors/logos, slide metadata, ending-slide ID, revision, and asset manifest.
- Duplicate copies content and branding into a separate presentation, without copying live sessions, votes, questions, or participant identities.
- Editing a slide changes the presentation revision and invalidates stale generated assets.
- Confirm destructive actions.

### SPEC-002 — Live sessions

- Authorized admin/presenter starts a session and obtains a unique audience URL and QR code.
- Attendees join anonymously without accounts; issue a session-scoped pseudonymous participant identity.
- Sessions have scheduled/live/completed states and persist progress and interaction data.
- Presenter can explicitly complete a session; visiting the ending slide alone does not complete it.
- Reconnect restores session state.

### SPEC-003 — Reveal.js plugin

- Provide a reusable `RevealAudience` plugin registering slide-change listeners and synchronizing with the live backend.
- Support stable `data-slide-id` and `data-title` metadata.
- Respect Reveal.js horizontal/vertical navigation and standard keyboard arrows.
- Only authorized presenter navigation updates authoritative session state.
- Backend failure must not prevent local slide navigation.

```ts
Reveal.initialize({
  plugins: [RevealMarkdown, RevealHighlight, RevealNotes, RevealAudience],
  audience: { sessionId: '...', endpoint: 'https://api.example.com' }
});
```

### SPEC-004 — Follow mode

- Default audience mode; tracks current speaker slide in real time.
- Shows slide title/number, ask-question button, emoji controls, and download option when authorized.
- Does **not** display the actual slide.
- Reconnect refreshes speaker position and access state.

### SPEC-005 — Solo mode

- Previous/Next controls browse only the explicit set of revealed slides, in presentation order.
- Switching to Solo mode does not affect the speaker.
- A revealed slide remains accessible forever within the session, including after speaker backtracking.
- A skipped slide is inaccessible until actually visited.
- Returning to Follow jumps to the speaker's current slide.
- Server validates slide access for audience APIs, not only frontend navigation.

### SPEC-006 — Slide-scoped questions

- Audience can submit questions against the currently selected slide in either mode.
- Questions belong to the whole slide (ignore fragment index).
- Name is optional; sanitize/validate content and rate-limit submissions.
- Presenter can mark pending questions answered or dismissed.
- Persist question text, participant, slide, status, and timestamp.

### SPEC-007 — Question upvoting

- One upvote per participant per question; allow retracting.
- Server-side uniqueness prevents duplicate votes.
- List sorts by votes or time; live counts propagate to connected clients.

### SPEC-008 — Embedded Q&A slide

- A dedicated Reveal.js slide declares `data-component="audience-qa"`.
- Its **list view** displays ranked questions, votes, slide titles, and statuses.
- Clicking a question transitions to an internal **detail view**: question on top, generated static image of the referenced slide below, and Back-to-list control.
- The detail view **does not navigate Reveal.js back to the referenced slide**. Reveal.js stays on the Q&A slide.
- Back and Escape return to list; maintain list sort/scroll where practical.
- Presenter can mark the question answered; projected view must remain legible.
- Handle missing slide image with an informative fallback.

### SPEC-009 — Emoji reactions

- Initial reactions: 👍 🤔 ❤️ 😴.
- Each reaction references a session and selected slide; rate-limit abuse.
- Presenter sees aggregated counts for the currently presented slide.
- Updates propagate live without disrupting navigation.

### SPEC-010 — Contextual polls

- Support single-choice, multiple-choice, and binary polls associated with slides.
- Presenter opens/closes polls and can reveal live results on the projected deck.
- Persist responses and enforce participant voting rules server-side.

### SPEC-011 — Adaptive navigation

- Configure navigation rules referencing stable slide IDs, poll options, and vote thresholds.
- Matching rules **suggest** destinations; presenter must explicitly confirm navigation.
- Visiting a destination reveals that slide; skipped slides stay unrevealed.
- Support horizontal and vertical Reveal.js destinations.

### SPEC-012 — Presenter view

- Present a current-slide viewport with clickable Up/Down/Left/Right controls, matching Reveal.js navigation.
- Standard keyboard arrow keys navigate the deck.
- Display real-time reaction counts, question count, and connected participant count.
- Keep administration/asset-generation buttons **outside** the live presenter view.
- Never expose presenter-only controls on the public projection.
- Speaker notes integration deferred.

### SPEC-013 — Browser-side PNG generation

- In the **admin panel**, provide Generate All Slide Images.
- Use browser-based DOM capture, not server-side headless Chromium, to render each slide's **final** visual state.
- No fragment-by-fragment exports.
- Preserve slide aspect ratio and styling; upload PNGs to R2.
- Associate assets with slide ID and presentation revision.
- Show progress and per-slide errors; allow retry.
- Do not interrupt live presentation delivery.
- Encapsulate capture behind a replaceable `SlideRenderer` interface.
- Investigate Reveal.js transforms, background images, external fonts, SVGs, cross-origin resources, and hidden/final fragment behavior in a proof of concept.

### SPEC-014 — Single-slide downloads

- Enable download iff `revealedSlideIds` contains slide ID **and** current-revision PNG exists.
- Available in Follow and Solo modes; remains available after speaker navigates away.
- Prevent unrevealed PNG access through audience endpoints or predictable public R2 URLs.

### SPEC-015 — Native Reveal.js PDF export

- Admin opens Reveal.js native print layout (`?print-pdf`) and uses browser print-to-PDF.
- Configure `pdfSeparateFragments: false` to avoid fragment-separated pages.
- Admin uploads the resulting PDF via the admin panel; store in R2 and associate with presentation revision.
- The PDF contains **all slides**, including slides skipped during a live delivery.
- Do not assume browser print dialogs can be automated by ordinary frontend JavaScript.
- Reject/flag stale PDFs after edits.

### SPEC-016 — Full presentation download

- Backend unlocks full PDF upon the first **authorized speaker visit** to the configured ending slide.
- This unlock is permanent for that session and independent of audience mode.
- Do not unlock solely because a participant navigates, or because an admin generated the PDF.
- Keep download disabled if the current-revision PDF is not uploaded, even after unlock; show an appropriate unavailable state.
- PDF includes skipped slides in MVP; exclusion is post-MVP.

### SPEC-017 — Presentation duplication

- Independent copy of content, slides, branding, and configuration.
- No copied sessions, audience data, questions, reactions, or votes.
- New revision/asset association; define whether asset binaries are copied or regenerated without accidentally linking mutable state.

### SPEC-018 — Security and abuse prevention

- Authenticate admin/presenter; authorize privileged REST/WebSocket operations.
- Anonymous attendees receive session-scoped opaque identities.
- Validate all messages with runtime schemas, authorize every action, sanitize display content.
- Implement per-participant rate limits and server-side voting invariants.
- Validate WebSocket origins and avoid leaking privileged tokens.
- Keep R2 private; issue authorized downloads or short-lived access grants.
- Define configurable retention/deletion for questions and pseudonymous IDs; minimize personal data.

### SPEC-019 — Resilience

- Presentation works offline from the interaction backend.
- Reconnect WebSockets with backoff; resynchronize state.
- Support idempotent client events, deduplication, and consistent persistence.
- Handle reconnects and temporary loss of projected/presenter interfaces without losing authoritative state.

### SPEC-020 — Automated testing

- Unit tests: slide visibility, session completion, unlock rules, navigation, vote uniqueness.
- Integration: Worker/Durable Object/SQLite/D1/R2 boundaries and auth.
- E2E: presenter navigation, Follow/Solo, Q&A list/detail/back, asset access.
- Export: PNG fidelity and final-state behavior, native PDF workflow.
- Security: unauthorized access, replay, duplicate votes, rate limits.
- Performance: realistic 500-concurrent-participant workload, stretch 1,000; include reconnects and bursts.

### SPEC-021 — Word clouds

- Admin defines a word-cloud prompt on a slide.
- Attendees submit short text responses; normalize/aggregate equivalent terms.
- Presenter can open, close, reset, and display a live word cloud.
- Limit submission frequency; basic moderation.

### SPEC-022 — Session completion and download unlock

- Configure designated ending slide in presentation settings.
- Visiting it unlocks the PDF without changing `status` to completed.
- Completion requires explicit presenter action.
- Returning to earlier slides never revokes revealed-slide access or PDF unlock.

### SPEC-023 — Presenter/projector synchronization

- Projected deck and presenter view share one authoritative session state.
- Authorized navigation from either presenter-controlled interface updates both.
- Reconnection restores position; concurrent commands resolve deterministically.
- Attendee events never directly navigate the deck.

### SPEC-024 — Asset access control

- Admin can preview assets before live delivery.
- Attendee PNG downloads require slide revelation and a generated asset.
- Full PDF downloads require ending-slide unlock and a current PDF.
- Never rely solely on hiding buttons or obscuring R2 keys.
- Public Reveal.js deck source is not treated as secret; stronger spoiler prevention is out of MVP scope.

## 6. API and real-time contracts

### Proposed HTTP API

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/v1/presentations` | Create presentation |
| GET | `/api/v1/presentations/{id}` | Retrieve metadata |
| POST | `/api/v1/presentations/{id}/duplicate` | Duplicate presentation |
| POST | `/api/v1/presentations/{id}/assets` | Register/upload generated assets |
| POST | `/api/v1/presentations/{id}/sessions` | Create live session |
| GET | `/api/v1/sessions/{id}` | Audience-safe state |
| POST | `/api/v1/sessions/{id}/join` | Anonymous join |
| GET | `/api/v1/sessions/{id}/questions` | Question list |
| GET | `/api/v1/sessions/{id}/slides/{slideId}/download` | Authorized PNG |
| GET | `/api/v1/sessions/{id}/download` | Authorized PDF |

### Event envelope

```ts
interface RealtimeEvent<T = unknown> {
  id: string;
  type: string;
  sessionId: string;
  timestamp: string;
  payload: T;
}
```

Event families: `session.joined`, `session.state`, `slide.changed`, `question.submitted`, `question.updated`, `question.upvoted`, `reaction.added`, `reaction.summary`, `poll.opened`, `poll.closed`, `poll.voted`, `poll.results`, `wordcloud.submitted`, `wordcloud.updated`, `navigation.suggested`, `presentation.download.unlocked`.

The agent should specify concrete payload schemas, actor authorization, error semantics, and idempotency behavior before implementation.

## 7. Non-functional targets

| Dimension | Target |
|---|---|
| Typical concurrent participants | 300–500 |
| Stretch test | 1,000 |
| Slide sync latency | p95 < 500 ms under representative load |
| Reaction aggregate latency | p95 < 1 second |
| Browsers | Current Chrome, Firefox, Safari, Edge; iOS Safari and Android Chrome |
| Accessibility | WCAG 2.2 AA target |
| Deployments | Wrangler and GitHub Actions |
| Observability | Structured logs, error metrics, connection counts, session activity |
| Cost | Prefer Cloudflare free allowances; document and test quota assumptions |

Performance targets are objectives, not service guarantees.

## 8. Implementation plan

1. **Foundations:** Monorepo, local Wrangler setup, D1 metadata, Durable Object session, R2 storage, admin authentication.
2. **Navigation:** Reveal.js plugin, session creation, presenter/projector synchronization, keyboard controls.
3. **Audience:** Join, Follow/Solo, revealed-slide authorization and reconnect.
4. **Q&A:** Questions, upvotes, dedicated Q&A slide, list/detail/back transitions.
5. **Reactions:** Per-slide reactions and presenter aggregates.
6. **Interactions:** Polls, word clouds, presenter-approved adaptive navigation.
7. **Exports:** Admin-triggered PNG capture, native PDF export/upload, gated downloads.
8. **Hardening:** Security, resilience, realistic load tests, accessibility, observability.

Implement **vertical slices** with automated tests and an end-to-end demonstration at each phase. Avoid building every persistence layer before proving the first live interaction.

## 9. Coding-agent instructions

- Use TypeScript strict mode and clear domain boundaries.
- Separate domain rules from framework/infrastructure adapters.
- Validate external inputs at runtime; authorize all privileged operations.
- Favor simple, testable components over speculative abstractions.
- Maintain ADRs for consequential decisions.
- Make state transitions and access policies explicit and testable.
- Design for WebSocket reconnect, deduplication, and session isolation.
- Do not introduce headless Chromium for MVP exports.
- Do not implement speaker notes, fragment-specific Q&A, skipped-slide PDF filtering, or speaker-only asset restrictions in MVP.
- Investigate technical uncertainties with executable spikes: DOM capture fidelity; Reveal.js PDF print workflow; Durable Object WebSocket capacity/hibernation; Q&A keyboard event conflicts.
- Verify Cloudflare service limits, billing prerequisites, and plan restrictions against current documentation before provisioning.

## 10. Definition of Done

An administrator can create and duplicate branded presentations, generate all slide PNGs through browser DOM capture, create a PDF through Reveal.js native export and upload it, and start a session. A presenter can navigate using arrows, view real-time reactions, open a dedicated Q&A slide, select a question, display the question with its referenced slide image, and return to the list. Attendees can join anonymously, Follow or browse revealed slides in Solo mode, ask/upvote questions, react, answer polls and word clouds, download revealed/generated PNGs, and download the full PDF only after the ending slide is reached. All slides, including skipped ones, are included in the PDF. The platform passes automated functional/security tests and a representative 500-user load test, and the Reveal.js presentation remains navigable when the real-time backend is unavailable.
