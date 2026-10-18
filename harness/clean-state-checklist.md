# Harness Clean State Protocol & Checklist

> Harness Engineering Practices 9 & 12: End-of-Session Clean State & Victory Verification.
> Must be executed and verified before concluding any engineering session or handing off tasks.

## 1. Clean Worktree Protocol
- [ ] No untracked scratch files, `.swp` files, temporary logs, or `.temp` directories in git status.
- [ ] No uncommitted modifications that do not belong to the active feature.
- [ ] No secrets, private tokens, or test credentials written to disk.

## 2. Mechanical Verification Protocol
- [ ] **Harness Subsystems Valid**:
  ```bash
  node harness/validate-harness.mjs
  ```
  *Exits with 0 (All 5 subsystems present, AGENTS.md <= 120 lines, WIP<=1, evidence valid).*
- [ ] **Pure Domain Boundary Clean**:
  ```bash
  node harness/verify-architecture.mjs
  ```
  *Exits with 0 (Zero Cloudflare, React, or Reveal.js imports in domain/application).*
- [ ] **Strict Format & Lint Clean**:
  ```bash
  pnpm run format:check && pnpm run lint
  ```
  *Exits with 0 (Zero Biome format or lint violations).*
- [ ] **Strict TypeScript Types Clean**:
  ```bash
  pnpm run typecheck
  ```
  *Exits with 0 (Zero TypeScript diagnostic errors).*
- [ ] **Full Automated Test Suite Passing**:
  ```bash
  pnpm test
  ```
  *Exits with 0 (All unit, integration, and E2E tests green).*

## 3. Three-Layer Victory Gate
- [ ] **Execute Victory Detector**:
  ```bash
  node harness/victory-detector.mjs
  ```
  *Layer 1: Static file & structural integrity verified.*
  *Layer 2: Feature list state & evidence verified.*
  *Layer 3: Session progress & handoff completeness verified.*

## 4. Continuity State Artifacts
- [ ] `feature_list.json` updated with latest status, verification commands, and evidence.
- [ ] `claude-progress.md` appended with session summary, timestamps, and test counts.
- [ ] `session-handoff.md` overwritten with verified state, changes, and exact reproducer commands.
