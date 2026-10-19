/**
 * maker-checker-graph.mjs
 * Agora Maker-Checker Autonomous State Machine & Graph (Practice 13 & 14)
 *
 * Implements an executable Node.js state graph executing:
 * Maker Node -> Checker Node -> Evaluator Rubric -> Conditional Router -> Termination / Checkpoint
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const checkpointPath = path.join(rootDir, 'harness', '.loop-checkpoint.json');

class MakerCheckerGraph {
  constructor(initialState) {
    this.state = initialState;
  }

  saveCheckpoint() {
    fs.writeFileSync(checkpointPath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  makerNode() {
    this.state.iteration += 1;
    console.log(
      `\n[Maker Node] Starting Iteration ${this.state.iteration} for Feature ${this.state.activeFeatureId}`,
    );

    // Simulate/Record Maker Node execution
    this.state.makerOutput = {
      filesModified: [
        'packages/domain/src/entities/session.ts',
        'packages/domain/tests/session.test.ts',
      ],
      commitIntent: `Implement ${this.state.activeFeatureId} domain rules`,
      verificationCommand: 'node harness/verify-architecture.mjs',
      selfReportedStatus: 'ready_for_check',
    };

    this.saveCheckpoint();
    return 'checker';
  }

  checkerNode() {
    console.log(
      `[Checker Node] Auditing Iteration ${this.state.iteration} against Evaluator Rubric`,
    );

    let archClean = false;
    let harnessClean = false;

    try {
      execSync(`"${process.execPath}" harness/verify-architecture.mjs`, {
        cwd: rootDir,
        stdio: 'pipe',
      });
      archClean = true;
    } catch {
      archClean = false;
    }

    try {
      execSync(`"${process.execPath}" harness/validate-harness.mjs`, {
        cwd: rootDir,
        stdio: 'pipe',
      });
      harnessClean = true;
    } catch {
      harnessClean = false;
    }

    const allPassed = archClean && harnessClean;
    const rubricScore = allPassed ? 49 : 28;

    this.state.checkerOutput = {
      status: allPassed ? 'approved' : 'rejected',
      architectureClean: archClean,
      harnessClean: harnessClean,
      rubricScore,
      feedback: allPassed
        ? 'All mechanical checks and domain boundaries verified.'
        : 'Mechanical verification failed. Review boundary logs.',
    };

    this.saveCheckpoint();

    // Conditional router
    if (this.state.checkerOutput.status === 'approved') {
      return 'complete';
    }
    if (this.state.iteration >= this.state.maxIterations) {
      return 'max_iterations_reached';
    }
    return 'maker';
  }

  run() {
    console.log('======================================================');
    console.log(' Agora Practice 14 State Graph Orchestrator');
    console.log('======================================================');

    let nextNode = 'maker';

    while (nextNode !== 'complete' && nextNode !== 'max_iterations_reached') {
      if (nextNode === 'maker') {
        nextNode = this.makerNode();
      } else if (nextNode === 'checker') {
        nextNode = this.checkerNode();
      }
    }

    console.log('------------------------------------------------------');
    if (nextNode === 'complete') {
      console.log(
        `🎉 Graph completed successfully with rubric score ${this.state.checkerOutput.rubricScore}/50.`,
      );
      // Clean up checkpoint
      if (fs.existsSync(checkpointPath)) {
        fs.unlinkSync(checkpointPath);
      }
      return 0;
    }

    console.error(
      `💥 Graph halted: Maximum iterations (${this.state.maxIterations}) reached without passing checks.`,
    );
    return 1;
  }
}

// Execution entry point
const initialState = {
  sessionId: 'sess_cli_001',
  activeFeatureId: 'SPEC-001',
  iteration: 0,
  maxIterations: 3,
  makerOutput: null,
  checkerOutput: null,
};

const graph = new MakerCheckerGraph(initialState);
const exitCode = graph.run();
process.exit(exitCode);
