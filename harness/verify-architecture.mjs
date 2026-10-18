/**
 * verify-architecture.mjs
 * Agora Clean Architecture Mechanical Boundary Linter (Practice 10)
 *
 * Scans packages/domain and packages/application to guarantee that pure domain
 * and application logic never import Cloudflare Workers, React, Reveal.js, or apps/*.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const targetDirs = [
  path.join(rootDir, 'packages', 'domain', 'src'),
  path.join(rootDir, 'packages', 'application', 'src'),
];

// Forbidden import regex patterns
const forbiddenPatterns = [
  {
    regex: /from\s+['"]cloudflare:.*['"]|import\s+['"]cloudflare:.*['"]/i,
    description: 'Cloudflare Worker runtime import (cloudflare:*)',
  },
  {
    regex: /from\s+['"]@cloudflare\/.*['"]|import\s+['"]@cloudflare\/.*['"]/i,
    description: 'Cloudflare Workers types/SDK import (@cloudflare/*)',
  },
  {
    regex: /from\s+['"]react(-dom)?['"]|import\s+['"]react(-dom)?['"]/i,
    description: 'React library import',
  },
  {
    regex: /from\s+['"]reveal\.js(\/.*)?['"]|import\s+['"]reveal\.js(\/.*)?['"]/i,
    description: 'Reveal.js presentation library import',
  },
  {
    regex:
      /from\s+['"].*\/apps\/.*['"]|import\s+['"].*\/apps\/.*['"]|from\s+['"]@agora\/(admin|audience|presenter|worker)['"]/i,
    description: 'Inward dependency leak from application layer (apps/*)',
  },
];

let violationCount = 0;
let scannedFileCount = 0;

function scanDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      scanDirectory(fullPath);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      scannedFileCount += 1;
      checkFile(fullPath);
    }
  }
}

function checkFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];

    // Skip commented-out imports
    if (line.trim().startsWith('//') || line.trim().startsWith('/*')) {
      continue;
    }

    for (const rule of forbiddenPatterns) {
      if (rule.regex.test(line)) {
        violationCount += 1;
        const relPath = path.relative(rootDir, filePath);
        console.error(`❌ [Architecture Boundary Violation] ${relPath}:${idx + 1}`);
        console.error(`   Found: ${line.trim()}`);
        console.error(`   Rule:  ${rule.description}\n`);
      }
    }
  }
}

console.log('--> Running Agora Mechanical Architecture Boundary Linter...');
for (const dir of targetDirs) {
  scanDirectory(dir);
}

if (violationCount > 0) {
  console.error(
    `💥 Architecture verification failed! ${violationCount} boundary violation(s) found across ${scannedFileCount} file(s).`,
  );
  process.exit(1);
} else {
  console.log(
    `✅ Pure domain architecture verified. ${scannedFileCount} file(s) scanned, 0 violations found.`,
  );
  process.exit(0);
}
