# Agora Loop State Template

> Harness Engineering Practice 13: Loop State Schema for Multi-Agent Orchestration.

```json
{
  "session_id": "sess_loop_001",
  "active_feature_id": "SPEC-006",
  "iteration": 1,
  "max_iterations": 5,
  "current_node": "maker",
  "maker_output": {
    "files_modified": [
      "packages/domain/src/entities/question.ts",
      "packages/domain/tests/question.test.ts"
    ],
    "commit_intent": "Implement slide-scoped question domain entity and validation rules",
    "verification_command": "vitest run packages/domain/tests/question.test.ts",
    "self_reported_status": "ready_for_check"
  },
  "checker_output": {
    "status": "pending",
    "architecture_clean": null,
    "tests_passed": null,
    "feedback": null,
    "rubric_score": null
  },
  "history": []
}
```
