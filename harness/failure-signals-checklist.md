# Harness Failure Signals Checklist

> Harness Engineering Practice 1: Failure Detection & Mitigation Catalog.
> Review this checklist whenever an agent shows signs of looping, regression, or degraded reasoning.

## 1. Top Agent Failure Modes & Detection Signatures

| Failure Signal | Detection Signature | Root Cause | Immediate Mechanical Countermeasure |
|---|---|---|---|
| **1. Phantom Pass / Hallucinated Success** | Agent claims "tests pass" without running `pnpm test` or without showing exit code 0. | Sycophancy / lazy completion bias. | Enforce `validate-harness.mjs` and `init.sh`. Features in `feature_list.json` require verifiable test command outputs. |
| **2. Architectural Drift / Boundary Leak** | `packages/domain` or `packages/application` imports `cloudflare:workers`, `react`, or `reveal.js`. | Framework convenience bias. | Run `node harness/verify-architecture.mjs`. Fails build immediately on any framework import in pure domain packages. |
| **3. WIP Spillover (WIP > 1)** | More than 1 feature marked `in_progress` in `feature_list.json`. | Task switching without finishing verification. | Mechanically enforced by `validate-harness.mjs` rule: `in_progress <= 1`. |
| **4. Unverified Passing Declaration** | Feature marked `passing` in `feature_list.json` with empty `verification` or `evidence` arrays. | Premature victory bias. | Mechanically blocked by `validate-harness.mjs` and `victory-detector.mjs`. |
| **5. Monolithic Router Bloat** | `AGENTS.md` exceeds 120 lines or duplicates deep documentation. | Failure to use Progressive Disclosure. | Line count limit strictly enforced by `validate-harness.mjs`. Direct deep details to `docs/` and `sops/`. |
| **6. Compounding Errors / Thrashing** | Agent modifies same lines 3+ times without inspecting root error stack trace. | Guess-and-check coding loop. | Switch to Maker-Checker loop (`harness/maker-checker-graph.mjs`). Pause and run isolated single test command. |
| **7. Dirty Worktree at Handoff** | Scratch files, `.temp`, or untracked test logs left in working directory. | Incomplete end-of-session protocol. | Run `clean-state-checklist.md` before updating `session-handoff.md`. |
| **8. Out-of-Scope Scope Creep** | Adding speaker notes, attendee chat, or headless Chromium PDF rendering. | Ignoring product boundary rules. | Cross-check against `docs/PRODUCT_SENSE.md` non-goals list before implementing. |

---

## 2. Recovery Protocol when a Failure Signal Fires
1. **Stop execution immediately**. Do not commit further edits.
2. Identify the failure signal ID from the table above.
3. Execute the corresponding mechanical countermeasure command.
4. If tests fail, view the exact stderr and traceback.
5. Revert unverified speculative edits: `git checkout -- <file>`.
6. Resume through the canonical loop in `AGENT.md`.
