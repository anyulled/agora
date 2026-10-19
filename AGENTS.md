# AGENTS.md — Agora Agent Operating System & Router

> Router file adhering to Harness Engineering Practice 4 (<120 lines). Read this file first on every invocation.

## 1. Startup Workflow
Run this sequence before taking any task action:
1. `pwd` — Ensure you are in `/Users/alrs/Documents/agora`.
2. Inspect `agent-progress.md` — Identify last completed session, blockers, and recent changes.
3. Inspect `feature_list.json` — Review feature status (WIP=1 invariant). Check active or failing features.
4. `git log --oneline -5` — Understand recent atomic commits.
5. `./init.sh` — Run canonical baseline verification (lint, architecture check, typecheck, tests).
6. Verify existing smoke / E2E behavior before making changes.

## 2. Working Rules & Invariants
- **WIP = 1**: At most one feature in `in_progress` in `feature_list.json` at any time.
- **ACID Progress Updates**: Whenever you modify code, update `feature_list.json` and `agent-progress.md` atomically in the same step.
- **Passing Requires Evidence**: A feature cannot be marked `passing` without a non-empty `verification` command list and concrete `evidence` log entry.
- **Pure Domain Boundary**: `packages/domain` and `packages/application` MUST NEVER import Cloudflare Workers, React, DOM, or Reveal.js (`verify-architecture.mjs`).
- **Local Cloudflare Emulation First**: Favor emulating Cloudflare services (D1 SQLite, Durable Object embedded SQLite `ctx.storage.sql`, R2 buckets, WebSocket hibernation) locally via `createLocalCloudflareEnv` (`node:sqlite` + local R2) and `pnpm run cf:emulate` before any remote deployment.
- **Conventional Commits & Git Hooks**: All commits MUST follow Conventional Commits (`<type>(<scope>): <subject>`) enforced by `.githooks/commit-msg` (`harness/verify-commit-msg.mjs`) and `.githooks/pre-commit`.
- **No Hallucinated Pass**: Never claim a test or check passed without running it and inspecting the return code and stdout/stderr.

## 3. Progressive Disclosure Index
Load specialized documentation only when the current task demands it:
- **System of Record**: [`ARCHITECTURE.md`](./ARCHITECTURE.md) (monorepo layout, data flow, SQLite/D1/R2, contracts)
- **Functional Requirements**: [`SPECIFICATION.md`](./SPECIFICATION.md) (features SPEC-001 through SPEC-024)
- **Design & Invariants**: [`docs/DESIGN.md`](./docs/DESIGN.md) (UX invariants, projector separation, Q&A detail view)
- **Frontend & A11y**: [`docs/FRONTEND.md`](./docs/FRONTEND.md) (WCAG 2.2 AA, Follow vs Solo, RevealAudience plugin)
- **Security & Auth**: [`docs/SECURITY.md`](./docs/SECURITY.md) (session-scoped tokens, rate limits, R2 gatekeeper)
- **Reliability & Scale**: [`docs/RELIABILITY.md`](./docs/RELIABILITY.md) (offline Reveal fallback, WebSocket reconnection, 500-1k peers)
- **Product Boundaries**: [`docs/PRODUCT_SENSE.md`](./docs/PRODUCT_SENSE.md) (scope fences, non-goals)
- **Quality Scorecard**: [`docs/QUALITY_SCORE.md`](./docs/QUALITY_SCORE.md) (system health matrix)
- **Implementation Slices**: [`docs/PLANS.md`](./docs/PLANS.md) (8 vertical delivery slices)
- **Architectural Decisions**: [`docs/adr/`](./docs/adr/) (`0001-clean-architecture.md`, `0002-browser-dom-capture.md`)
- **Standard Operating Procedures**: [`sops/`](./sops/) (layered domain, DevTools loop, observability, knowledge encoding)
- **Harness & Automation**: [`harness/`](./harness/) (checklists, rubrics, architecture verifier, victory detector)

## 4. Required Artifacts
On every feature completion or significant change:
1. `feature_list.json` — Updated status, verification array, and evidence array.
2. `agent-progress.md` — Append session log with timestamp, changes, verification output, and blockers.
3. `session-handoff.md` — Overwritten with current Verified Now, Changed, Broken/Unverified, Next Best Step.

## 5. Definition of Done
1. Code conforms to Clean Architecture (`packages/domain` and `packages/application` remain pure).
2. Biome format and lint pass: `pnpm run format:check && pnpm run lint`.
3. Strict TypeScript typechecking passes: `pnpm run typecheck`.
4. Automated tests pass: `pnpm run test` (unit, integration, e2e, perf as applicable).
5. Mechanical harness verification passes: `pnpm run harness:validate && pnpm run harness:arch`.
6. Three-Layer victory detector passes: `pnpm run harness:victory`.

## 6. End of Session Clean State Protocol
Before handing off or ending session:
1. Run `./init.sh` and ensure zero failures.
2. Ensure no untracked scratch files or uncommitted temporary files are left in the worktree.
3. Update `session-handoff.md` with explicit reproducer commands for the next engineer.
