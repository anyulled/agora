# Agora Security, Authentication & Abuse Prevention

> Progressive Disclosure document detailing security mechanisms, token models, rate limits, and asset gating.

## 1. Authentication & Authorization Model

Agora adopts a tiered security model separating privileged administrative roles from anonymous conference attendees:

```
┌────────────────────────────────────────────────────────┐
│                        ROLES                           │
├───────────────────┬───────────────────┬────────────────┤
│       Admin       │     Presenter     │    Audience    │
├───────────────────┼───────────────────┼────────────────┤
│ Full CRUD, D1,    │ Navigates deck,   │ Submits Qs,    │
│ duplicates,       │ triggers polls,   │ votes, reacts, │
│ uploads assets    │ marks answered    │ downloads      │
├───────────────────┼───────────────────┼────────────────┤
│ Bearer JWT /      │ Session Key or    │ Opaque Token   │
│ Cloudflare Access │ Presenter Token   │ (Session Scope)│
└───────────────────┴───────────────────┴────────────────┘
```

### 1. Admin Authentication
- Admin endpoints (`/api/v1/presentations/*`) require a signed cryptographic Bearer JWT or integration with Cloudflare Zero Trust Access.
- Mutations (create, edit, publish, duplicate, delete) require admin scope.

### 2. Presenter Authentication
- Starting a session generates a cryptographically random `presenterToken` (UUIDv4/HMAC).
- Presenter navigation and moderation WebSocket messages require this token.
- Navigation events sent without presenter authorization are rejected and logged.

### 3. Audience Anonymous Tokens
- Attendees join anonymously via `POST /api/v1/sessions/:id/join`.
- The server generates an opaque session-scoped participant ID (e.g. `part_c9b8...`) and returns a signed session token.
- Token is stored in `sessionStorage` on the attendee's mobile browser.
- Pseudonymous tokens are strictly scoped to the single session and discarded upon session completion.

---

## 2. Rate Limiting & Abuse Prevention

To prevent disruption from malicious conference attendees or rogue scripts:

| Action | Rate Limit (per participant) | Enforcement Layer | Failure Behavior |
|---|---|---|---|
| Question Submission | 1 question per 10 seconds (max 5 per session) | Worker / Durable Object | HTTP 429 / WS error message |
| Question Upvoting | 1 upvote toggle per 500ms | Durable Object SQLite | Throttled / Debounced |
| Emoji Reactions | Max 5 reactions per 2 seconds | In-memory token bucket (DO) | Excess reactions dropped silently |
| Poll Responses | 1 submission per active poll | Durable Object SQLite | Ignored / HTTP 409 |
| Word Cloud Submissions | Max 3 words per prompt | Durable Object SQLite | HTTP 429 / WS error |

### Input Sanitization & Content Security
- All question text and word cloud submissions are strictly validated using runtime schemas (`packages/contracts`).
- Submissions are sanitized to strip HTML, control characters, and scripts before persistence.
- Maximum question length: 280 characters.
- Maximum word cloud token: 30 characters (stripped of punctuation and normalized to lowercase).

---

## 3. Storage Invariants & Vote Uniqueness

### Composite Primary Keys in SQLite
Duplicate voting is prevented mechanically at the database level:
```sql
CREATE TABLE IF NOT EXISTS question_upvotes (
  question_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (question_id, participant_id)
);

CREATE TABLE IF NOT EXISTS poll_votes (
  poll_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  voted_at TEXT NOT NULL,
  PRIMARY KEY (poll_id, participant_id)
);
```

Attempts to insert duplicate votes result in atomic no-ops (`INSERT OR IGNORE`), guaranteeing that race conditions or network retries never inflate vote counts.

---

## 4. Private R2 Bucket & Gated Asset Access

Presentation slide PNGs and PDFs are stored in a **private Cloudflare R2 bucket** with no public URLs enabled.

### Gated Download Endpoints:
1. **Single-Slide PNG (`GET /api/v1/sessions/:id/slides/:slideId/download`)**:
   - Worker queries the session's Durable Object.
   - Checks if `slideId` is present in `revealedSlideIds`.
   - If not revealed: **HTTP 403 Forbidden**.
   - If revealed: Streams the PNG from R2 with appropriate content headers.
2. **Full Presentation PDF (`GET /api/v1/sessions/:id/download`)**:
   - Worker queries the session's Durable Object.
   - Checks if `pdfDownloadUnlocked === true`.
   - If locked: **HTTP 403 Forbidden**.
   - If unlocked: Verifies that the PDF asset exists for the current revision, then streams the file.
