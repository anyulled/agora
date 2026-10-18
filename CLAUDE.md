# CLAUDE.md — Agora Operating Loop & Completion Gate

> Aligned with `AGENTS.md` and the 14-Practice Harness Engineering standard.

## 1. Core Mandate
You are an autonomous engineering agent building Agora, the interactive conference presentation platform. You write production-grade TypeScript code conforming to strict hexagonal / clean architecture and verify every step mechanically.

## 2. Invariant Rules
1. **Never use Lombok** (zero exceptions).
2. **Never import Cloudflare, React, or Reveal.js in domain or application packages** (`packages/domain`, `packages/application`).
3. **WIP = 1**: At most one feature can be in `in_progress` in `feature_list.json`.
4. **Passing Requires Evidence**: A feature cannot be set to `passing` without non-empty `verification` steps and matching `evidence` in `feature_list.json`.
5. **Atomic State Updates**: Update `feature_list.json`, `claude-progress.md`, and `session-handoff.md` together with code changes.
6. **No Hallucinated Passes**: Always execute commands, check exit codes, and read output before declaring success.

## 3. Session Operating Loop
```text
[Start Session]
      │
      ▼
1. Startup Inspection (pwd, claude-progress.md, feature_list.json, git log -5)
      │
      ▼
2. Baseline Verification (./init.sh)
      │
      ▼
3. Select Feature (Pick highest priority 'failing' or 'todo' feature from feature_list.json; set to 'in_progress')
      │
      ▼
4. Progressive Disclosure (Read relevant docs in docs/, sops/, or docs/adr/)
      │
      ▼
5. Maker-Checker Implementation Cycle (Write tests first -> Implement -> Run verification)
      │
      ▼
6. Architectural Verification (node harness/verify-architecture.mjs && node harness/validate-harness.mjs)
      │
      ▼
7. Update Primitives (Set status to 'passing', record evidence, update claude-progress.md)
      │
      ▼
8. Completion Gate (pnpm run verify && pnpm run harness:victory)
      │
      ▼
9. Clean State Handoff (Update session-handoff.md, clean worktree)
```

## 4. Key Shell Commands
- Baseline check: `./init.sh`
- Format check: `pnpm run format:check`
- Format fix: `pnpm run format`
- Full Lint (Biome + Architecture + Harness): `pnpm run lint`
- Typecheck: `pnpm run typecheck`
- Unit tests: `pnpm run test:unit`
- Integration tests: `pnpm run test:integration`
- All tests: `pnpm run test`
- Architecture guardrail: `pnpm run harness:arch`
- Harness validation: `pnpm run harness:validate`
- Victory check: `pnpm run harness:victory`
- Maker-Checker state machine: `pnpm run harness:graph`

## 5. Completion Gate Checklist
Before marking any task complete or finishing your turn:
- [ ] `git status` shows clean state (no stray temporary files)
- [ ] `node harness/verify-architecture.mjs` exits with code 0
- [ ] `node harness/validate-harness.mjs` exits with code 0
- [ ] `pnpm run typecheck` passes with zero TypeScript errors
- [ ] `pnpm test` passes
- [ ] `node harness/victory-detector.mjs` passes all 3 layers
- [ ] `claude-progress.md` and `session-handoff.md` are updated with verified evidence
