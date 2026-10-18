# Agora Agent Goal Specification Template

> Harness Engineering Practice 13: Goal Formulation Template for Autonomous Loops.

## Goal Overview
- **Feature ID**: [e.g. SPEC-006]
- **Feature Title**: [e.g. Slide-scoped questions]
- **Target Area**: [admin | session | reveal | audience | qa | interactions | navigation | presenter | export | security | resilience | testing]
- **Session ID**: [e.g. SESS-20261018-002]

## User-Visible Behavior Objective
[Describe the precise behavior observable by the attendee, speaker, or admin upon completion.]

## Applicable Invariants
1. [Invariant 1, e.g. Domain packages cannot import Cloudflare or React]
2. [Invariant 2, e.g. Questions belong to slide ID, not fragment index]
3. [Invariant 3, e.g. WIP limit <= 1]

## Acceptance Criteria
- [ ] Criteria 1: [Specific behavior with input/output]
- [ ] Criteria 2: [Specific error/edge case handling]
- [ ] Criteria 3: [Unit test covers core domain logic]
- [ ] Criteria 4: [Integration test covers API endpoint / DO state]

## Verification Commands
```bash
# Unit verification
vitest run packages/domain/tests/...

# Full verification
./init.sh
```
