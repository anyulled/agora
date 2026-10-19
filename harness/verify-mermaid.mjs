#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.wrangler', 'coverage']);

let mermaidInstance = null;

async function getMermaid() {
  if (mermaidInstance) return mermaidInstance;
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Element = dom.window.Element;
  globalThis.SVGElement = dom.window.SVGElement;
  Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
  });
  const mod = await import('mermaid');
  mermaidInstance = mod.default;
  mermaidInstance.initialize({ startOnLoad: false });
  return mermaidInstance;
}

/**
 * Extracts all ```mermaid ... ``` code blocks from markdown text with 1-based line numbers.
 * @param {string} markdown
 * @returns {Array<{ index: number; startLine: number; endLine: number; code: string }>}
 */
export function extractMermaidBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  let inBlock = false;
  let startLine = 0;
  let currentLines = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!inBlock && /^\s*```mermaid\s*$/i.test(line)) {
      inBlock = true;
      startLine = i + 1;
      currentLines = [];
    } else if (inBlock && /^\s*```\s*$/.test(line)) {
      inBlock = false;
      blocks.push({
        index: blocks.length + 1,
        startLine,
        endLine: i + 1,
        code: currentLines.join('\n').trim(),
      });
    } else if (inBlock) {
      currentLines.push(line);
    }
  }

  return blocks;
}

/**
 * Validates a single Mermaid diagram string using the official Mermaid parser
 * plus GitHub Mermaid rendering compatibility checks.
 * @param {string} code
 * @returns {Promise<{ valid: boolean; diagramType?: string; error?: string }>}
 */
export async function validateMermaidDiagram(code) {
  const mermaid = await getMermaid();
  if (!code || !code.trim()) {
    return { valid: false, error: 'Empty Mermaid diagram block' };
  }

  try {
    const res = await mermaid.parse(code, { suppressErrors: false });
    const diagramType = typeof res === 'object' && res !== null ? res.diagramType : 'unknown';

    // Additional GitHub Mermaid compatibility check:
    // In sequenceDiagram, unescaped quotes or HTML tags inside unquoted message/note text,
    // or in flowchart, unquoted node labels containing parentheses/brackets/slashes cause GitHub render failures.
    const lines = code.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]?.trim() ?? '';
      if (!line || line.startsWith('%%')) continue;

      // Check flowchart unquoted labels with parentheses/brackets: e.g. NodeId[Label (info)]
      if (/^(flowchart|graph)\b/i.test(lines[0]?.trim() ?? '')) {
        const unquotedBracketMatch = line.match(/\b[A-Za-z0-9_]+\[(?![["])([^\]"]*[()][^\]"]*)\]/);
        if (unquotedBracketMatch) {
          return {
            valid: false,
            diagramType,
            error: `Line ${i + 1}: Unquoted flowchart node label contains parentheses: [${unquotedBracketMatch[1]}]. Quote the label as ["${unquotedBracketMatch[1]}"].`,
          };
        }
      }
    }

    return { valid: true, diagramType };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: message };
  }
}

/**
 * Recursively collects markdown files from a directory.
 * @param {string} dir
 * @param {string[]} results
 * @returns {string[]}
 */
export function collectMarkdownFiles(dir = ROOT_DIR, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMarkdownFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Validates all Mermaid diagrams across Markdown files in the workspace.
 * @param {string[]} [targetFiles]
 * @returns {Promise<{ passed: boolean; filesChecked: number; diagramsValidated: number; errors: Array<{ file: string; blockIndex: number; startLine: number; error: string }> }>}
 */
export async function verifyWorkspaceMermaidDiagrams(targetFiles) {
  const files =
    targetFiles && targetFiles.length > 0 ? targetFiles : collectMarkdownFiles(ROOT_DIR);
  const errors = [];
  let diagramsValidated = 0;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const blocks = extractMermaidBlocks(content);
    for (const block of blocks) {
      diagramsValidated += 1;
      const result = await validateMermaidDiagram(block.code);
      if (!result.valid) {
        errors.push({
          file: path.relative(ROOT_DIR, file),
          blockIndex: block.index,
          startLine: block.startLine,
          error: result.error ?? 'Unknown Mermaid syntax error',
        });
      }
    }
  }

  return {
    passed: errors.length === 0,
    filesChecked: files.length,
    diagramsValidated,
    errors,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const cliFiles = process.argv.slice(2).map((f) => path.resolve(process.cwd(), f));
  const report = await verifyWorkspaceMermaidDiagrams(cliFiles.length > 0 ? cliFiles : undefined);

  if (!report.passed) {
    console.error('====================================================================');
    console.error('❌ MERMAID DIAGRAM VALIDATION FAILED');
    console.error('====================================================================');
    for (const err of report.errors) {
      console.error(
        `  - ${err.file}:${err.startLine} (diagram #${err.blockIndex}):\n    ${err.error}`,
      );
    }
    console.error('--------------------------------------------------------------------');
    console.error(
      'ACTION REQUIRED: Fix the Mermaid syntax error(s) above and re-run `pnpm run lint:mermaid`.',
    );
    console.error('====================================================================');
    process.exit(1);
  }

  console.log(
    `✅ Mermaid validation passed (${report.diagramsValidated} diagram(s) across ${report.filesChecked} Markdown file(s)).`,
  );
  process.exit(0);
}
