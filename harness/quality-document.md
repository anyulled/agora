# Agora Quality Document & Engineering Baseline

> Harness Engineering Practice 12: Quality System of Record.
> Defines non-negotiable software quality invariants, verification standards, and operational gates.

## 1. Non-Negotiable Quality Invariants

1. **Lombok Prohibition**:
   Never use Project Lombok anywhere in the codebase. Agora is a pure TypeScript monorepo; Java/Lombok conventions have zero place here.
2. **Strict Hexagonal / Clean Boundaries**:
   Domain business logic and application use cases must never be coupled to Cloudflare, React, or browser-specific globals.
3. **Mechanical Verification Over Self-Reporting**:
   No human or AI agent's claim of "working" is accepted without automated command execution producing exit code 0 and verifiable evidence.
4. **Offline Presentation Resilience**:
   The speaker must be able to deliver their presentation locally with standard keyboard arrows even if all backend services fail completely.
5. **Session Isolation**:
   Data from one presentation session must never leak into another session. Presentation duplication must copy only content and branding metadata, never session data.
6. **Public Presentation Safety**:
   Presenter view controls, question moderation buttons, and reaction aggregations must never be visible on the public projection screen.

---

## 2. Quality Verification Gates

| Phase | Gate Command | Criteria for Pass |
|---|---|---|
| **Format** | `pnpm run format:check` | 100% compliant with Biome style rules. |
| **Lint** | `pnpm run lint` | 0 lint errors, 0 boundary violations, 0 harness issues. |
| **Types** | `pnpm run typecheck` | 0 TypeScript errors across all workspace packages. |
| **Tests** | `pnpm test` | All unit, integration, and E2E tests pass. |
| **Harness** | `pnpm run harness:validate` | All 5 subsystems valid, WIP<=1, evidence non-empty. |
| **Architecture** | `pnpm run harness:arch` | Zero forbidden imports in `packages/domain` and `packages/application`. |
| **Victory** | `pnpm run harness:victory` | All 3 termination layers green. |

---

## 3. Continuous Audit Baseline
- Any regression in test count, code coverage, or architectural boundary purity triggers an automatic pipeline failure in `.github/workflows/ci.yml`.
- All code changes must leave the repository in a cleaner state than when the session began (Boy Scout Rule).
