import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export function evaluateDuplicationOutput(rawOutput, maxThreshold = 10) {
  // Strip ANSI escape codes so bolded numbers like "\u001b[1m1.7%\u001b[22m duplication" parse cleanly
  const ansiRegex = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const output = String(rawOutput || '').replace(ansiRegex, '');

  // Parse total duplication percentage e.g. "1.7% duplication"
  let totalDuplicationPercent = 0;
  const totalMatch = output.match(/(\d+(?:\.\d+)?)%\s+duplication/i);
  if (totalMatch) {
    totalDuplicationPercent = Number.parseFloat(totalMatch[1]);
  }

  // Parse per-file duplication percentages from --summary output
  // Example: worker/src/index.ts 8206/1277/43.8K/287/8.7%
  const violatingFiles = [];
  const fileLines = output.split('\n');
  const fileRegex = /^\s*(\S+)\s+\d+\/\d+\/\S+\/\d+\/(\d+(?:\.\d+)?)%/;

  for (const line of fileLines) {
    const m = line.match(fileRegex);
    if (m) {
      const filePath = m[1];
      const percent = Number.parseFloat(m[2]);
      if (percent > maxThreshold) {
        violatingFiles.push({ file: filePath, duplicationPercent: percent });
      }
    }
  }

  // Parse clone pairs under Clones:
  const clones = [];
  let capturingClones = false;
  for (const line of fileLines) {
    const trimmed = line.trim();
    if (trimmed === 'Clones:') {
      capturingClones = true;
      continue;
    }
    if (capturingClones) {
      if (trimmed.startsWith('---')) {
        capturingClones = false;
        continue;
      }
      if (trimmed) {
        clones.push(trimmed);
      }
    }
  }

  const valid = totalDuplicationPercent <= maxThreshold && violatingFiles.length === 0;

  const message = valid
    ? `✅ Code duplication check passed (${totalDuplicationPercent}% total duplication <= ${maxThreshold}% threshold; 0 files > ${maxThreshold}%).`
    : `❌ [Code Duplication Threshold Exceeded (> ${maxThreshold}%)] Please refactor duplicated code blocks using DRY extraction strategies (extract shared helper function, parameterize common handler logic, or move shared domain/application logic into a reusable module). Run 'npx jscpd --reporters ai --summary packages apps harness infrastructure' (see sops/jscpd-dry-refactoring.md) to inspect clone hotspots.`;

  return {
    valid,
    totalDuplicationPercent,
    violatingFiles,
    clones,
    message,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const proc = spawnSync(
    'pnpm',
    [
      'exec',
      'jscpd',
      '--config',
      '.jscpd.json',
      '--reporters',
      'ai',
      '--summary',
      '--no-tips',
      'packages',
      'apps',
      'harness',
      'infrastructure',
    ],
    {
      cwd: rootDir,
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
    },
  );

  const output = `${proc.stdout || ''}\n${proc.stderr || ''}`;
  const result = evaluateDuplicationOutput(output, 10);

  if (!result.valid || proc.status !== 0) {
    console.error(result.message);
    if (result.violatingFiles.length > 0) {
      console.error('\nViolating Files (>10% duplication):');
      for (const vf of result.violatingFiles) {
        console.error(
          `  - ${vf.file}: ${vf.duplicationPercent}% (exceeds 10% limit — refactor duplicated blocks)`,
        );
      }
    }
    if (result.clones.length > 0) {
      console.error('\nDetected Clone Locations:');
      for (const clone of result.clones) {
        console.error(`  - ${clone}`);
      }
    }
    process.exit(1);
  } else {
    console.log(result.message);
    process.exit(0);
  }
}
