# Evaluator Rubric & Quality Gates

> Harness Engineering Practice 11: Quantitative & Qualitative Evaluation Rubric.
> Used by independent checker agents and CI pipelines to objectively evaluate implementations.

## 1. Evaluation Dimensions & Scoring Rubric

Each feature or slice is graded on a 0–10 scale across five core dimensions (Maximum score: 50 points):

### Dimension 1: Architectural Boundary Purity (Weight: 25%)
- **10/10**: `packages/domain` and `packages/application` contain zero external framework imports. Ports and adapters pattern strictly adhered to. `verify-architecture.mjs` passes with 0 warnings.
- **7/10**: Clean architecture respected, but minor leakage in utility functions or shared types.
- **3/10**: Domain logic directly imports React hooks or Cloudflare Worker globals.
- **0/10**: Monolithic file combining UI, DB queries, and business rules.

### Dimension 2: Test Rigor & Verification Evidence (Weight: 25%)
- **10/10**: Feature has deterministic unit and integration tests. Edge cases, failure modes, and race conditions covered. Non-empty `verification` and `evidence` in `feature_list.json`.
- **7/10**: Happy path tested; error paths or rate limits untested.
- **3/10**: Test file exists but asserts trivial properties (`expect(true).toBe(true)`).
- **0/10**: No tests written or test command skipped.

### Dimension 3: Resilience & Fault Tolerance (Weight: 20%)
- **10/10**: Reveal.js operates offline from network. WebSocket reconnects with exponential backoff and jitter. SQLite transactions idempotent with composite keys.
- **7/10**: System handles normal disconnects but drops state during rapid re-sync.
- **3/10**: Network drop freezes presentation or crashes audience interface.
- **0/10**: Uncaught exceptions crash the worker or wipe session state.

### Dimension 4: User Experience & Accessibility (Weight: 15%)
- **10/10**: WCAG 2.2 AA compliant. Touch targets >= 44x44px. Invariants respected (audience never sees slides; Q&A detail never navigates Reveal.js).
- **7/10**: Functionally working, but minor a11y warnings or missing ARIA labels.
- **3/10**: Presentation slide content leaks onto audience mobile screen.
- **0/10**: Completely broken UI or inaccessible to keyboard/screen readers.

### Dimension 5: Code Quality & Harness Adherence (Weight: 15%)
- **10/10**: Clean Biome format/lint, strict TypeScript zero errors, WIP=1 maintained, `agent-progress.md` and `session-handoff.md` updated.
- **7/10**: Typecheck passes with `any` casts or unformatted code.
- **3/10**: WIP limit violated, missing progress updates.
- **0/10**: Syntax errors, broken builds, or corrupted git worktree.

---

## 2. Quantitative Quality Gates

| Grade | Total Score | Merge Eligibility | Required Remediation |
|---|---|---|---|
| **A+** | 48–50 | **Eligible for Instant Merge** | None. Gold standard implementation. |
| **A** | 44–47 | **Eligible for Merge** | Address minor comments during subsequent session. |
| **B** | 35–43 | **Blocked** | Must fix test gaps or architectural leaks before merge. |
| **C / F** | < 35 | **Blocked & Rejected** | Trigger rollback and initiate Checker diagnostic loop. |
