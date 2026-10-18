# SOP: Encoding Knowledge into the Repository

> Standard Operating Procedure for capturing discovered knowledge, edge cases, and operational lessons directly into repo assets (Harness Engineering Practice 6).

## 1. Principles
Knowledge stored only in an agent's conversational context is lost when context expires. In Agora, all technical insights, failure modes, design constraints, and operational lessons must be immediately codified into persistent repo assets.

## 2. Where Knowledge Belongs

| Type of Knowledge | Target Artifact | Action Required |
|---|---|---|
| **System boundaries & architecture** | `ARCHITECTURE.md` | Update diagrams, topology, or invariant tables. |
| **New invariant or feature requirement** | `SPECIFICATION.md` & `feature_list.json` | Add SPEC entry or refine user-visible behavior. |
| **Architectural trade-off or decision** | `docs/adr/NNNN-title.md` | Write formal ADR with Context, Decision, and Consequences. |
| **UX, accessibility, or security rules** | `docs/DESIGN.md`, `docs/SECURITY.md`, etc. | Update relevant progressive disclosure guide. |
| **Repeatable procedural workflows** | `sops/your-procedure.md` | Codify step-by-step SOP with verification checks. |
| **Failure modes & agent traps** | `harness/failure-signals-checklist.md` | Add detection signature and corrective action. |
| **Session progress & handoffs** | `claude-progress.md` & `session-handoff.md` | Record verified evidence and next best step. |

## 3. Operational Rules
1. **Never Leave Knowledge in Chat**: If you discover a bug, an edge case with Cloudflare Durable Objects, a Reveal.js event timing issue, or a DOM capture quirk, update the relevant SOP or ADR before closing the task.
2. **Atomic Commits**: Bundle code changes with the documentation updates that describe the new behavior.
3. **Keep Router Thin**: Do NOT bloat `AGENTS.md` or `CLAUDE.md`. Add progressive disclosure pointers to the appropriate `docs/` or `sops/` file.
