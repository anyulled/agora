/**
 * validate-harness.mjs
 * Agora 14-Practice Harness Subsystem & Invariant Validator (Practices 2, 4, 7, 8)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

let errors = 0;

function reportError(msg) {
  console.error(`❌ [Harness Validation Error] ${msg}`);
  errors += 1;
}

function reportSuccess(msg) {
  console.log(`✅ ${msg}`);
}

// 1. Verify the 5 Core Harness Subsystems (Practice 2)
const requiredSubsystemFiles = [
  // Subsystem 1: Router & Operating Loop
  'README.md',
  'AGENTS.md',
  'AGENT.md',
  // Subsystem 2: System of Record
  'ARCHITECTURE.md',
  'SPECIFICATION.md',
  // Subsystem 3: Primitive State
  'feature_list.json',
  // Subsystem 4: Progress Ledger
  'agent-progress.md',
  'session-handoff.md',
  // Subsystem 5: Mechanical Linters, Git Hooks & Guardrails
  'eslint.config.mjs',
  '.jscpd.json',
  'commitlint.config.mjs',
  'harness/validate-harness.mjs',
  'harness/verify-architecture.mjs',
  'harness/verify-duplication.mjs',
  'harness/verify-mermaid.mjs',
  'harness/verify-openapi.mjs',
  'harness/verify-commit-msg.mjs',
  'harness/victory-detector.mjs',
  'docs/openapi.json',
  'sops/jscpd-dry-refactoring.md',
  '.githooks/pre-commit',
  '.githooks/commit-msg',
];

console.log('--> Checking 5 Harness Subsystems...');
for (const relPath of requiredSubsystemFiles) {
  const fullPath = path.join(rootDir, relPath);
  if (!fs.existsSync(fullPath)) {
    reportError(`Missing required harness subsystem file: ${relPath}`);
  }
}

if (errors === 0) {
  reportSuccess('All 5 core harness subsystems exist.');
}

// 2. Validate AGENTS.md Line Count (Practice 4: <120 lines constraint)
const agentsPath = path.join(rootDir, 'AGENTS.md');
if (fs.existsSync(agentsPath)) {
  const content = fs.readFileSync(agentsPath, 'utf8');
  const lines = content.split('\n').length;
  if (lines > 120) {
    reportError(`AGENTS.md exceeds 120 lines (found ${lines} lines). Keep the router concise!`);
  } else {
    reportSuccess(`AGENTS.md is within line limit (${lines} lines <= 120).`);
  }
}

// 3. Validate feature_list.json Schema & Rules (Practices 7 & 8)
const featureListPath = path.join(rootDir, 'feature_list.json');
if (fs.existsSync(featureListPath)) {
  try {
    const rawData = fs.readFileSync(featureListPath, 'utf8');
    const data = JSON.parse(rawData);

    if (data.project !== 'agora') {
      reportError("feature_list.json 'project' must be 'agora'.");
    }

    if (!data.rules || typeof data.rules !== 'object') {
      reportError("feature_list.json missing 'rules' object.");
    } else {
      if (data.rules.single_active_feature !== true) {
        reportError('rules.single_active_feature must be true.');
      }
      if (data.rules.passing_requires_evidence !== true) {
        reportError('rules.passing_requires_evidence must be true.');
      }
      if (data.rules.do_not_skip_verification !== true) {
        reportError('rules.do_not_skip_verification must be true.');
      }
    }

    if (!Array.isArray(data.features)) {
      reportError("feature_list.json 'features' must be an array.");
    } else {
      let inProgressCount = 0;
      const seenIds = new Set();

      for (const feat of data.features) {
        if (!feat.id || seenIds.has(feat.id)) {
          reportError(`Duplicate or missing feature ID: ${feat.id}`);
        }
        seenIds.add(feat.id);

        if (feat.status === 'in_progress') {
          inProgressCount += 1;
        }

        if (feat.status === 'passing') {
          if (!Array.isArray(feat.verification) || feat.verification.length === 0) {
            reportError(
              `Feature ${feat.id} is marked 'passing' but has empty or missing 'verification' array.`,
            );
          }
          if (!Array.isArray(feat.evidence) || feat.evidence.length === 0) {
            reportError(
              `Feature ${feat.id} is marked 'passing' but has empty or missing 'evidence' array.`,
            );
          }
        }
      }

      // Invariant: WIP <= 1
      if (inProgressCount > 1) {
        reportError(
          `WIP limit violated! Only 1 feature may be 'in_progress' at a time (found ${inProgressCount}).`,
        );
      } else {
        reportSuccess(
          `feature_list.json validated (${data.features.length} features, WIP=${inProgressCount} <= 1).`,
        );
      }
    }
  } catch (err) {
    reportError(`Failed to parse feature_list.json: ${err.message}`);
  }
}

console.log('------------------------------------------------------');
if (errors > 0) {
  console.error(`💥 Harness validation failed with ${errors} error(s).`);
  process.exit(1);
} else {
  console.log('🎉 14-Practice Harness validation passed successfully.');
  process.exit(0);
}
