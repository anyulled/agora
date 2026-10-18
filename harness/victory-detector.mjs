/**
 * victory-detector.mjs
 * Agora Three-Layer Victory Detector & Termination Guard (Practice 9)
 *
 * Verifies three distinct layers before allowing project release or victory declaration:
 * Layer 1: Static file & structural integrity
 * Layer 2: Feature list passing status with empirical evidence
 * Layer 3: Progress ledger & session continuity completeness
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

let layerErrors = 0;

function failLayer(layer, msg) {
  console.error(`❌ [Layer ${layer} Violation] ${msg}`);
  layerErrors += 1;
}

function passLayer(layer, msg) {
  console.log(`✅ [Layer ${layer} Passed] ${msg}`);
}

console.log('======================================================');
console.log(' Agora Three-Layer Victory Detector (Practice 9)');
console.log('======================================================');

// ============================================================================
// LAYER 1: Static File & Structural Integrity
// ============================================================================
console.log('\n--> Evaluating Layer 1: Static Workspace Integrity...');

const layer1Files = [
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'biome.json',
  'eslint.config.mjs',
  '.jscpd.json',
  'SPECIFICATION.md',
  'ARCHITECTURE.md',
  'AGENTS.md',
  'CLAUDE.md',
  'init.sh',
  'docs/DESIGN.md',
  'docs/FRONTEND.md',
  'docs/PLANS.md',
  'docs/PRODUCT_SENSE.md',
  'docs/QUALITY_SCORE.md',
  'docs/RELIABILITY.md',
  'docs/SECURITY.md',
  'docs/adr/0001-clean-architecture-and-cloudflare-stack.md',
  'docs/adr/0002-browser-dom-capture-and-native-pdf-export.md',
  'sops/chrome-devtools-validation-loop.md',
  'sops/encode-knowledge-into-repo.md',
  'sops/jscpd-dry-refactoring.md',
  'sops/layered-domain-architecture.md',
  'sops/observability-feedback-loop.md',
  'harness/failure-signals-checklist.md',
  'harness/clean-state-checklist.md',
  'harness/evaluator-rubric.md',
  'harness/quality-document.md',
  'harness/verify-duplication.mjs',
  'harness/verify-mermaid.mjs',
];

let layer1Missing = 0;
for (const rel of layer1Files) {
  const full = path.join(rootDir, rel);
  if (!fs.existsSync(full)) {
    failLayer(1, `Required static file missing: ${rel}`);
    layer1Missing += 1;
  }
}

if (layer1Missing === 0) {
  passLayer(1, `All ${layer1Files.length} structural specifications and configurations exist.`);
}

// ============================================================================
// LAYER 2: Feature Status & Verification Evidence (Practice 7 & 8)
// ============================================================================
console.log('\n--> Evaluating Layer 2: Feature State & Evidence Verification...');

const featureListPath = path.join(rootDir, 'feature_list.json');
if (!fs.existsSync(featureListPath)) {
  failLayer(2, 'feature_list.json is missing.');
} else {
  try {
    const raw = fs.readFileSync(featureListPath, 'utf8');
    const data = JSON.parse(raw);

    if (!Array.isArray(data.features) || data.features.length === 0) {
      failLayer(2, 'No features found in feature_list.json.');
    } else {
      let passingCount = 0;
      let nonPassingCount = 0;
      let missingEvidenceCount = 0;

      for (const feat of data.features) {
        if (feat.status === 'passing') {
          passingCount += 1;
          const hasVerification = Array.isArray(feat.verification) && feat.verification.length > 0;
          const hasEvidence = Array.isArray(feat.evidence) && feat.evidence.length > 0;

          if (!hasVerification || !hasEvidence) {
            missingEvidenceCount += 1;
            failLayer(
              2,
              `Feature ${feat.id} (${feat.title}) is 'passing' but lacks verifiable evidence records.`,
            );
          }
        } else {
          nonPassingCount += 1;
        }
      }

      if (nonPassingCount > 0) {
        failLayer(2, `${nonPassingCount} feature(s) are not in 'passing' status.`);
      }

      if (missingEvidenceCount === 0 && nonPassingCount === 0) {
        passLayer(
          2,
          `All ${passingCount} features verified passing with non-empty executable evidence.`,
        );
      }
    }
  } catch (err) {
    failLayer(2, `Failed to parse feature_list.json: ${err.message}`);
  }
}

// ============================================================================
// LAYER 3: Progress Ledger & Session Continuity Completeness
// ============================================================================
console.log('\n--> Evaluating Layer 3: Progress Ledger & Session Handoff...');

const progressPath = path.join(rootDir, 'claude-progress.md');
const handoffPath = path.join(rootDir, 'session-handoff.md');

let layer3Ok = true;
if (!fs.existsSync(progressPath)) {
  failLayer(3, 'claude-progress.md is missing.');
  layer3Ok = false;
} else {
  const content = fs.readFileSync(progressPath, 'utf8').trim();
  if (content.length < 50) {
    failLayer(3, 'claude-progress.md is too short or empty.');
    layer3Ok = false;
  }
}

if (!fs.existsSync(handoffPath)) {
  failLayer(3, 'session-handoff.md is missing.');
  layer3Ok = false;
} else {
  const content = fs.readFileSync(handoffPath, 'utf8').trim();
  if (!content.includes('## Verified Now') || !content.includes('## Next Best Step')) {
    failLayer(3, 'session-handoff.md is missing required sections (Verified Now, Next Best Step).');
    layer3Ok = false;
  }
}

if (layer3Ok) {
  passLayer(3, 'Session progress log and structured handoff documentation verified.');
}

// ============================================================================
// SUMMARY & EXIT
// ============================================================================
console.log('\n------------------------------------------------------');
if (layerErrors > 0) {
  console.error(
    `💥 Victory Detector HALTED: ${layerErrors} check(s) failed across the 3 termination layers.`,
  );
  process.exit(1);
} else {
  console.log('🏆 VICTORY DETECTED: All 3 termination layers verified successfully!');
  process.exit(0);
}
