"""
maker_checker_graph.py - Agora Multi-Agent Orchestration Graph (Practice 14 Reference)

Implements the LangGraph StateGraph orchestration for the Maker-Checker autonomous loop
with state persistence, evaluator rubrics, and conditional routing.
"""

from typing import TypedDict, List, Optional, Literal
from dataclasses import dataclass
import subprocess
import json

class MakerOutput(TypedDict):
    files_modified: List[str]
    commit_intent: str
    verification_command: str
    self_reported_status: str

class CheckerOutput(TypedDict):
    status: Literal["approved", "rejected"]
    architecture_clean: bool
    tests_passed: bool
    rubric_score: int
    feedback: Optional[str]

class LoopState(TypedDict):
    session_id: str
    active_feature_id: str
    iteration: int
    max_iterations: int
    maker_output: Optional[MakerOutput]
    checker_output: Optional[CheckerOutput]
    history: List[dict]

def maker_node(state: LoopState) -> LoopState:
    """
    Maker Agent Node:
    Implements target feature, runs local format/tests, and prepares handoff.
    """
    iteration = state["iteration"] + 1
    feature_id = state["active_feature_id"]
    print(f"[MakerNode] Starting iteration {iteration} for feature {feature_id}")
    
    # Maker executes code edits and preliminary checks
    maker_output: MakerOutput = {
        "files_modified": [
            f"packages/domain/src/{feature_id.lower()}.ts",
            f"packages/domain/tests/{feature_id.lower()}.test.ts"
        ],
        "commit_intent": f"Implement {feature_id} business invariants and tests",
        "verification_command": "pnpm test",
        "self_reported_status": "ready_for_check"
    }
    
    state["iteration"] = iteration
    state["maker_output"] = maker_output
    state["history"].append({"node": "maker", "iteration": iteration, "output": maker_output})
    return state

def checker_node(state: LoopState) -> LoopState:
    """
    Checker Agent Node:
    Independently runs mechanical linters, architecture verifiers, and tests.
    """
    print(f"[CheckerNode] Evaluating iteration {state['iteration']} against Rubric")
    
    # Mechanical Check 1: Architecture boundary linter
    arch_res = subprocess.run(["node", "harness/verify-architecture.mjs"], capture_output=True, text=True)
    arch_clean = (arch_res.returncode == 0)
    
    # Mechanical Check 2: Harness validation
    harness_res = subprocess.run(["node", "harness/validate-harness.mjs"], capture_output=True, text=True)
    harness_clean = (harness_res.returncode == 0)
    
    # Mechanical Check 3: Automated tests
    test_res = subprocess.run(["pnpm", "test"], capture_output=True, text=True)
    tests_passed = (test_res.returncode == 0)
    
    all_passed = arch_clean and harness_clean and tests_passed
    score = 48 if all_passed else 30
    status = "approved" if all_passed else "rejected"
    feedback = None if all_passed else f"Architecture: {arch_clean}, Harness: {harness_clean}, Tests: {tests_passed}"
    
    checker_output: CheckerOutput = {
        "status": status,
        "architecture_clean": arch_clean,
        "tests_passed": tests_passed,
        "rubric_score": score,
        "feedback": feedback
    }
    
    state["checker_output"] = checker_output
    state["history"].append({"node": "checker", "iteration": state["iteration"], "output": checker_output})
    return state

def should_continue(state: LoopState) -> Literal["complete", "retry", "max_iterations"]:
    """
    Conditional router edge:
    Determines whether loop terminates in success, retries maker, or halts on max iterations.
    """
    checker = state.get("checker_output")
    if checker and checker["status"] == "approved":
        return "complete"
    if state["iteration"] >= state["max_iterations"]:
        return "max_iterations"
    return "retry"

def build_maker_checker_graph():
    """
    Constructs the LangGraph compilation pipeline.
    (Requires `langgraph` package when executed in Python agent environments).
    """
    try:
        from langgraph.graph import StateGraph, END
    except ImportError:
        print("[Notice] langgraph not installed in Python env. Reference specification loaded.")
        return None

    workflow = StateGraph(LoopState)
    workflow.add_node("maker", maker_node)
    workflow.add_node("checker", checker_node)
    
    workflow.set_entry_point("maker")
    workflow.add_edge("maker", "checker")
    
    workflow.add_conditional_edges(
        "checker",
        should_continue,
        {
            "complete": END,
            "retry": "maker",
            "max_iterations": END
        }
    )
    return workflow.compile()

if __name__ == "__main__":
    initial_state: LoopState = {
        "session_id": "sess_py_001",
        "active_feature_id": "SPEC-001",
        "iteration": 0,
        "max_iterations": 3,
        "maker_output": None,
        "checker_output": None,
        "history": []
    }
    print("Agora Practice 14 LangGraph Reference Initialized.")
